import { expect, test } from "@playwright/test";

test("shows dashboard heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Farm Dashboard" })).toBeVisible();
});
