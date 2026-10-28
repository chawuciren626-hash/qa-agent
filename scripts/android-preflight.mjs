import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AndroidAdbError,
  adbErrorText,
  adbText,
  classifyAdbFailure,
  listDevices,
  selectDevice
} from './android-adb.mjs';
import {
  probeAppium,
  probeJava,
  readAppInfo,
  readDeviceFacts,
  resolveLauncherActivity
} from './android-device.mjs';

function check(id, status, detail) {
  return { id, status, detail };
}

function sdkFacts(explicitRoot, env) {
  const root = explicitRoot || env.ANDROID_SDK_ROOT || env.ANDROID_HOME || null;
  if (!root) return { root: null, available: false, components: [] };
  const components = ['platform-tools', 'platforms', 'build-tools'].filter(name => existsSync(resolve(root, name)));
  return { root, available: existsSync(root), components };
}

export async function runAndroidPreflight({
  runner,
  device,
  packageName,
  sdkRoot,
  env = process.env,
  checkJava = true,
  appiumUrl = null,
  allowLocked = false,
  javaProbe = probeJava,
  appiumProbe = probeAppium
} = {}) {
  const checks = [];
  const limitations = [];
  const blockers = [];
  const result = {
    version: 1,
    status: 'blocked',
    backend: 'adb',
    checked_at: new Date().toISOString(),
    device: null,
    package: packageName ?? null,
    app: null,
    sdk: sdkFacts(sdkRoot, env),
    appium: null,
    checks,
    blockers,
    limitations
  };
  const block = (id, reason, detail) => {
    checks.push(check(id, 'blocked', detail));
    blockers.push({ id, reason, detail });
  };
  try {
    const adb = await runner.run(['version'], { timeout: 10000 });
    if (adb.code === 0 && !adb.timedOut) {
      checks.push(check('adb', 'ok', adbText(adb).split(/\r?\n/)[0] ?? 'adb available'));
    } else {
      const category = classifyAdbFailure(adb, 'adb version');
      block('adb', category, (adbErrorText(adb) || adbText(adb)).slice(0, 300));
    }
  } catch (error) {
    block('adb', error.category ?? 'adb_not_found', error.message);
  }
  result.sdk.available
    ? checks.push(check('android_sdk', 'ok', `${result.sdk.root} (${result.sdk.components.join(', ') || 'no standard components'})`))
    : checks.push(check('android_sdk', 'warning', result.sdk.root ? `SDK path exists but is incomplete: ${result.sdk.root}` : 'ANDROID_HOME/ANDROID_SDK_ROOT is not set; ADB-only operations may still work'));
  if (!result.sdk.available) limitations.push('Android SDK root was not detected; Gradle/native-test execution is not available.');
  if (checkJava) {
    const java = await javaProbe();
    if (java.available) checks.push(check('java', 'ok', java.version ?? 'java available'));
    else {
      checks.push(check('java', 'warning', java.detail ?? 'java was not found'));
      limitations.push('Java is not available; Appium/Gradle-based execution is not ready.');
    }
  } else {
    checks.push(check('java', 'skipped', 'not requested'));
  }
  if (appiumUrl) {
    const appium = await appiumProbe(appiumUrl);
    result.appium = appium;
    checks.push(check('appium', appium.available ? 'ok' : 'warning', appium.available ? `Appium ${appium.version ?? ''}`.trim() : `Appium unavailable: ${appium.reason}`));
    if (!appium.available) limitations.push('Appium endpoint is unavailable; only the ADB backend was checked.');
  } else {
    checks.push(check('appium', 'skipped', 'no Appium endpoint supplied; ADB backend only'));
    limitations.push('This check covers the ADB backend only; no Appium session was created.');
  }
  let devices = [];
  try {
    devices = await listDevices(runner);
    if (devices.length) checks.push(check('devices', 'ok', devices.map(row => `${row.serial}:${row.state}`).join(', ')));
    else {
      block('devices', 'device_not_found', 'No Android device or emulator is connected');
      return result;
    }
  } catch (error) {
    block('devices', error.category ?? 'device_not_found', error.message);
    return result;
  }
  let selected;
  try {
    selected = selectDevice(devices, device);
    checks.push(check('device_selected', 'ok', selected.serial));
  } catch (error) {
    block('device_selected', error.category ?? 'device_not_found', error.message);
    return result;
  }
  let facts;
  try {
    facts = await readDeviceFacts(runner, selected.serial);
    result.device = facts;
  } catch (error) {
    block('device_facts', error.category ?? 'command_failed', error.message);
    return result;
  }
  facts.boot_completed === '1'
    ? checks.push(check('boot', 'ok', 'sys.boot_completed=1'))
    : block('boot', 'device_not_booted', `Device ${selected.serial} has not completed booting (sys.boot_completed=${facts.boot_completed ?? 'unknown'})`);
  if (facts.screen?.locked === true && !allowLocked) {
    block('screen', 'device_locked', 'The device is locked; unlock it or pass allowLocked/unlock explicitly');
  } else if (facts.screen?.locked === true) {
    checks.push(check('screen', 'warning', 'Device is locked; the caller explicitly allowed it'));
  } else if (facts.screen?.locked === null) {
    checks.push(check('screen', 'warning', 'Lock state could not be determined by this Android version'));
    limitations.push('Screen lock state is unknown; app launch may be blocked by the keyguard.');
  } else {
    checks.push(check('screen', 'ok', `awake=${facts.screen?.awake}, locked=${facts.screen?.locked}`));
  }
  if (facts.activity?.component) checks.push(check('activity', 'ok', facts.activity.component));
  else {
    checks.push(check('activity', 'warning', 'No resumed activity was reported'));
    limitations.push('Current foreground activity could not be determined.');
  }
  if (packageName) {
    try {
      const app = await readAppInfo(runner, selected.serial, packageName);
      result.app = app;
      if (app.installed) {
        checks.push(check('package', 'ok', `${packageName}${app.version_name ? ` versionName=${app.version_name}` : ''}`));
        const launcher = await resolveLauncherActivity(runner, selected.serial, packageName);
        if (launcher) checks.push(check('launcher_activity', 'ok', launcher));
        else {
          checks.push(check('launcher_activity', 'warning', 'Launcher activity could not be resolved; start requires an explicit activity'));
          limitations.push('Launcher activity is unresolved; pass an explicit component before starting the app.');
        }
      } else {
        block('package', 'package_not_installed', `${packageName} is not installed on ${selected.serial}`);
      }
    } catch (error) {
      block('package', error.category ?? 'command_failed', error.message);
    }
  } else {
    checks.push(check('package', 'skipped', 'no target package requested'));
  }
  result.status = blockers.length ? 'blocked' : 'ready';
  return result;
}
