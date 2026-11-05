import { expect, type Page } from "@playwright/test"

export async function confirmSessionTabClose(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Close session tab", exact: true })

  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Close tab", exact: true }).click()
}
