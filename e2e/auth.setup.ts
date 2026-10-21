import { expect, test as setup } from '@playwright/test';
import { DM, DM_STATE } from './env';

// A project with its own server (the phone project) names its own state file in its metadata
setup('first-run setup creates the admin account', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.waitForURL('**/setup');
  await page.locator('input[name=displayName]').fill(DM.displayName);
  await page.locator('input[name=username]').fill(DM.username);
  await page.locator('input[name=password]').fill(DM.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/campaigns');
  await expect(page.getByRole('heading', { name: 'Campaigns' })).toBeVisible();
  await page.context().storageState({ path: (testInfo.project.metadata.state as string | undefined) ?? DM_STATE });
});
