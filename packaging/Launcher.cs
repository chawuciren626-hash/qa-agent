using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class Launcher {
  [STAThread]
  private static void Main() {
    string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    try {
      if (File.Exists(Path.Combine(root, ".product-upgrade", "active.json"))) throw new Exception("安装更新尚未结束；如安装被中断，请重新运行安装包恢复。");
      string setup = Path.Combine(root, "app", "engine", "scripts", "product-installed-start.mjs");
      var info = new ProcessStartInfo(Path.Combine(root, "runtime", "tools", "node", "node.exe"));
      info.Arguments = "\"" + setup + "\" \"" + Path.Combine(root, "installation.json") + "\"";
      info.WorkingDirectory = root;
      info.UseShellExecute = false;
      info.CreateNoWindow = true;
      info.RedirectStandardError = true;
      info.RedirectStandardOutput = true;
      using (var process = new Process()) {
        process.StartInfo = info;
        string error = "";
        process.ErrorDataReceived += (sender, e) => { if (e.Data != null && error.Length < 4000) error += e.Data + "\n"; };
        process.OutputDataReceived += (sender, e) => {};
        process.Start();
        process.BeginErrorReadLine();
        process.BeginOutputReadLine();
        process.WaitForExit();
        if (process.ExitCode != 0) MessageBox.Show("应用未能启动。\n" + error, "AITestHarness", MessageBoxButtons.OK, MessageBoxIcon.Error);
      }
    } catch (Exception e) {
      MessageBox.Show("安装可能不完整，请查看安装记录或重新安装。\n" + e.Message, "AITestHarness", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
  }
}
