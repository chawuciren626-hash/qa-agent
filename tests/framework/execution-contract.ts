import { expect, type Locator, type Page } from "@playwright/test";

export type DataIsolation = "read_only" | "isolated" | "shared";
export type AssertionMode = "dynamic_ui" | "dom_state" | "navigation" | "api_response" | "storage_state";

export interface ExecutionContract {
  dataIsolation: DataIsolation;
  prepare?: (page: Page) => Promise<void>;
  execute: (page: Page) => Promise<void>;
  verify: (page: Page) => Promise<void>;
  cleanup?: (page: Page) => Promise<void>;
}

export async function runWithLifecycle(page: Page, contract: ExecutionContract) {
  await contract.prepare?.(page);
  try {
    await contract.execute(page);
    await contract.verify(page);
  } finally {
    await contract.cleanup?.(page);
  }
}

export async function expectUpdatedTextAfterAction(locator: Locator, action: () => Promise<void>, expected: string | RegExp) {
  const previous = await locator.textContent();
  await action();
  await expect(locator).not.toHaveText(previous ?? "");
  await expect(locator).toContainText(expected);
}
