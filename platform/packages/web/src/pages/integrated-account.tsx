import { useState } from "react";
import { useAuth } from "../state/auth";
import { AccountCenter } from "./account-center";

/**
 * The user sign-in surface for the unified server.
 *
 * Keep the established AITestHarness login design, but call the same instance's
 * `/api/auth/*` endpoints directly. The retired account-client proxy must not
 * decide whether this page renders or replace it with the upstream generic form.
 */
export function IntegratedAccountPage() {
  const [signedIn, setSignedIn] = useState(false);
  const { refresh } = useAuth();
  if (signedIn) return <p className="p-6" role="status">登录成功，正在进入工作台…</p>;
  return (
    <AccountCenter
      integrated
      registrationEnabled={false}
      onSignedIn={() => {
        setSignedIn(true);
        void refresh();
      }}
    />
  );
}
