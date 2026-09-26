// Service worker: opens the terminal page in a tab or in the side panel.
importScripts("shared.js");

const TERMINAL_URL = chrome.runtime.getURL("terminal.html");

function openTab() {
  return chrome.tabs.create({ url: TERMINAL_URL });
}

async function openPanel(windowId) {
  if (!chrome.sidePanel) return openTab();
  try {
    await chrome.sidePanel.open({ windowId });
  } catch (err) {
    console.warn("sidePanel.open failed, falling back to a tab", err);
    return openTab();
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  const settings = await loadSettings();
  if (settings.actionOpens === "panel") {
    await openPanel(tab.windowId);
  } else {
    await openTab();
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "open-terminal-tab") {
    await openTab();
  } else if (command === "open-terminal-panel") {
    const windowId = tab ? tab.windowId : (await chrome.windows.getLastFocused()).id;
    await openPanel(windowId);
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    // First run: show the terminal page, which explains how to install the host
    // if it is not there yet.
    await openTab();
  }
});
