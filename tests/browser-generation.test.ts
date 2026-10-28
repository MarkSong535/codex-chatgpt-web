import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chatGptStopButton, chatGptThinkButtons, ChatGptTurnDomHealthTracker, setChatGptThinkMode } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_THINK_BUTTON_SELECTOR } from "../src/chatgpt-session";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("Think buttons do not require the 6.1.8 icon shape or type slash commands", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    // Exercise the semantic control supported in 6.1.5 without assuming the
    // September glyph/classes still exist. #766 shows Think as a visible button.
    for (const button of [
      '<button type="button" aria-pressed="false">Think</button>',
      '<button type="button" aria-pressed="false" aria-label="Think"><svg><use href="#brain"/></svg></button>',
    ]) {
      await page.setContent(`<form><div id="prompt-textarea" contenteditable="true"><span data-id="plugin:fixture" data-keyword="Codex Native2" contenteditable="false">Codex Native2</span></div>
        <button type="button" aria-pressed="false">Search</button>
        <button type="button" aria-pressed="false">Think harder</button>
        <button type="button" aria-pressed="false" hidden>Think</button>
        <div id="controls">${button}</div><button type="submit">Send</button></form>
        ${button}<script>
          window.actions=[];
          document.querySelector('form').onsubmit=e=>{e.preventDefault();window.actions.push('submit');};
          document.querySelector('[contenteditable]').oninput=()=>window.actions.push('input');
          document.querySelector('[contenteditable]').onkeydown=e=>window.actions.push(e.key);
          document.querySelector('#controls button').onclick=e=>{
            window.actions.push('click');
            e.currentTarget.setAttribute('aria-pressed',String(e.currentTarget.getAttribute('aria-pressed')!=='true'));
          };
        </script>`);
      const composer = page.locator("#prompt-textarea");
      const draft = await composer.innerHTML();
      expect(await page.locator(CHATGPT_THINK_BUTTON_SELECTOR).count()).toBe(0);
      const think = chatGptThinkButtons(composer);
      expect(await think.count()).toBe(1);
      await setChatGptThinkMode(composer, true);
      expect(await think.getAttribute("aria-pressed")).toBe("true");
      await setChatGptThinkMode(composer, true);
      await setChatGptThinkMode(composer, false);
      expect(await think.getAttribute("aria-pressed")).toBe("false");
      expect(await composer.innerHTML()).toBe(draft);
      expect(await page.evaluate(() => (window as any).actions)).toEqual(["click", "click"]);
      expect(await page.locator('body > button').getAttribute("aria-pressed")).toBe("false");
      expect(await page.getByRole("button", { name: "Search", exact: true }).getAttribute("aria-pressed")).toBe("false");
      expect(await page.getByRole("button", { name: "Think harder", exact: true }).getAttribute("aria-pressed")).toBe("false");
    }
    // A delayed button must be clicked once it mounts; the empty composer must
    // never receive /think while waiting for it.
    await page.locator('#controls button').evaluate(button => {
      const parent = button.parentElement!;
      button.remove();
      setTimeout(() => parent.append(button), 200);
    });
    await setChatGptThinkMode(page.locator("#prompt-textarea"), true);
    expect(await page.evaluate(() => (window as any).actions)).toEqual(["click", "click", "click"]);
    await page.locator('#controls button').evaluate(button => button.remove());
    await expect(setChatGptThinkMode(page.locator("#prompt-textarea"), true)).rejects.toThrow();
    expect(await page.evaluate(() => (window as any).actions)).toEqual(["click", "click", "click"]);
    expect(await page.locator("#prompt-textarea").innerText()).toBe("Codex Native2");
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("Think preserves both plugin pill formats and rejects plugin replacement", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    for (const { markup, identity, replacement } of [
      { markup: '<span data-id="plugin:fixture" data-keyword="Codex Native2" contenteditable="false">Codex Native2</span>',
        identity: "data-id", replacement: "plugin:other" },
      // Captured from the Free account composer on 2026-10-14. The display name
      // is visible text but belongs to the plugin, not to the user's prompt.
      { markup: '<span app-mention-path="app://fixture" app-mention-display-name="Clew review" contenteditable="false"><span>Clew review</span></span>',
        identity: "app-mention-path", replacement: "app://other" },
    ]) {
      await page.setContent(`<form><div role="textbox" contenteditable="true"><p>${markup} </p></div>
        <button type="button" aria-pressed="false">Think</button></form>
        <script>document.querySelector('button').onclick = event => {
          event.currentTarget.setAttribute('aria-pressed', String(event.currentTarget.getAttribute('aria-pressed') !== 'true'));
        };</script>`);
      const composer = page.getByRole("textbox");
      const original = await composer.innerHTML();
      await setChatGptThinkMode(composer, true);
      expect(await page.getByRole("button", { name: "Think", exact: true }).getAttribute("aria-pressed")).toBe("true");
      expect(await composer.innerHTML()).toBe(original);
      await setChatGptThinkMode(composer, false);
      await page.getByRole("button", { name: "Think", exact: true }).evaluate((element, change) => {
        element.addEventListener("click", () => {
          document.querySelector(`[${change.identity}]`)!.setAttribute(change.identity, change.replacement);
        });
      }, { identity, replacement });
      // The name is unchanged: replacing the actual plugin must still fail.
      const failure = await setChatGptThinkMode(composer, true).then(() => undefined, error => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("did not preserve the empty draft and selected connectors");
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("hidden duplicate Stop controls cannot turn live generation into an idle timeout", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button data-testid="stop-button">Stop</button>'
      + '<form data-chatgpt-composer><button type="button" aria-label="Stop" hidden>Stop</button></form>');
    const health = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
    const idle = { responsePresent: true, currentText: "", completionActionVisible: false, running: false };
    const stop = chatGptStopButton(page);
    expect(await stop.isVisible()).toBeTrue();
    expect(health.update({ ...idle, running: await stop.isVisible() }, 0)).toBeUndefined();
    expect(health.update({ ...idle, running: await stop.isVisible() }, 100_000)).toBeUndefined();
    await page.getByTestId("stop-button").evaluate(element => element.remove());
    expect(await stop.isVisible()).toBeFalse();
    expect(health.update({ ...idle, running: await stop.isVisible() }, 100_000)).toBeUndefined();
    expect(health.update({ ...idle, running: await stop.isVisible() }, 100_750)).toContain("without a final answer");
  } finally {
    await browser.close();
  }
});
