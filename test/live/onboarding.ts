import type { Page } from '@zirbel/engineering/browser';

/** Fresh browser profiles choose the normal game through the visible onboarding control. */
export async function skipFirstRunGuide(page: Page): Promise<void> {
  await page.waitFor("!!document.querySelector('.derby-guide[open] .guide-skip')", 30000);
  await page.click('.derby-guide[open] .guide-skip');
  await page.waitFor("!document.querySelector('.derby-guide[open]')", 30000);
}
