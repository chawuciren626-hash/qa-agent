import { test, expect } from '@playwright/test';

const base = new URL(process.env.QA_BASE_URL!);
const scenario = base.pathname.slice(1);
const scope = `acceptance-${Date.now()}-${process.pid}`;
const path = (resource: string) => `/api/${scenario}/${resource}?scope=${scope}`;

test.beforeEach(async ({ request, page }) => {
  expect((await request.post(path('reset'))).ok()).toBeTruthy();
  await page.goto(`/${scenario}?scope=${scope}`);
  await expect(page.getByRole('cell', { name: 'Sample document', exact: true })).toBeVisible();
});
test.afterEach(async ({ request }) => {
  expect((await request.post(path('reset'))).ok()).toBeTruthy();
});
test('TC-BASE-01 seed list', async ({ page }) => {
  await expect(page.getByRole('cell', { name: '120', exact: true })).toBeVisible();
});
test('TC-BASE-02 create draft', async ({ page }) => {
  await page.getByLabel('Title', { exact: true }).fill('New draft');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Created');
  await expect(page.getByRole('cell', { name: 'New draft', exact: true })).toBeVisible();
});
test('TC-BASE-03 empty title', async ({ page }) => {
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Title must contain 1-40 characters');
});
test('TC-BASE-04 long title', async ({ page }) => {
  await page.getByLabel('Title', { exact: true }).fill('X'.repeat(41));
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Title must contain 1-40 characters');
});
test('TC-BASE-05 negative budget', async ({ page }) => {
  await page.getByLabel('Title', { exact: true }).fill('Negative budget');
  await page.getByLabel('Budget', { exact: true }).fill('-1');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Budget must be a non-negative integer');
  await expect(page.getByRole('cell', { name: 'Negative budget', exact: true })).toHaveCount(0);
});
test('TC-BASE-06 delete draft', async ({ page }) => {
  await page.getByRole('button', { name: 'Delete Sample document', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Deleted');
  await expect(page.getByRole('cell', { name: 'Sample document', exact: true })).toHaveCount(0);
});
