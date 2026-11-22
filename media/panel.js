(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);

  const els = {
    subtitle: byId("subtitle"),
    meta: byId("meta"),
    locator: byId("locator"),
    quickBody: byId("quick-body"),
    deepBody: byId("deep-body"),
    deepStatusBar: byId("deep-status-bar"),
    deepStatusText: byId("deep-status-text"),
    deepBadge: byId("deep-badge"),
    deepTab: byId("deep-tab"),
    quickTab: byId("quick-tab"),
    viewQuick: byId("view-quick"),
    viewDeep: byId("view-deep"),
    deepError: byId("deep-error"),
    contextBody: byId("context-body"),
    contextChars: byId("context-chars"),
    contextBox: byId("context-box"),
    toast: byId("toast"),
    openButton: byId("btn-open"),
    copyButton: byId("btn-copy"),
    retryButton: byId("btn-retry"),
    settingsButton: byId("btn-settings"),
    pauseButton: byId("btn-pause"),
  };

  const state = {
    absolutePath: "",
    line: 1,
    activeTab: "quick",
    userPickedTab: false,
    deepEnabled: false,
    deepState: "idle",
    toastTimer: 0,
  };

  els.quickTab.addEventListener("click", () => setTab("quick", true));
  els.deepTab.addEventListener("click", () => {
    if (!state.deepEnabled) {
      return;
    }
    setTab("deep", true);
    if (state.deepState === "unavailable") {
      showDeepUnavailable();
    }
  });

  els.copyButton.addEventListener("click", () => {
    vscode.postMessage({ type: "copy" });
  });

  els.openButton.addEventListener("click", () => {
    if (!state.absolutePath) {
      return;
    }
    vscode.postMessage({
      type: "openFile",
      path: state.absolutePath,
      line: state.line,
    });
  });

  els.retryButton.addEventListener("click", () => {
    vscode.postMessage({ type: "retry" });
  });

  els.settingsButton.addEventListener("click", () => {
    vscode.postMessage({ type: "configure" });
  });

  els.pauseButton.addEventListener("click", () => {
    vscode.postMessage({ type: "toggleAuto" });
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const external = target.closest("a[data-external]");
    if (external instanceof HTMLAnchorElement) {
      event.preventDefault();
      const url = external.getAttribute("href");
      if (url) {
        vscode.postMessage({ type: "openExternal", url });
      }
      return;
    }

    const fileButton = target.closest("button[data-open-file]");
    if (fileButton instanceof HTMLButtonElement) {
      event.preventDefault();
      vscode.postMessage({
        type: "openFile",
        path: fileButton.getAttribute("data-open-file") || "",
        line: Number(fileButton.getAttribute("data-line") || "1"),
      });
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "quick":
        handleQuick(message);
        break;
      case "deepStatus":
        handleDeepStatus(message.status || {});
        break;
      case "deepChunk":
        handleDeepChunk(message);
        break;
      case "deepDone":
        handleDeepDone(message);
        break;
      case "deepError":
        handleDeepError(message);
        break;
      case "deepUnavailable":
        handleDeepUnavailable(message);
        break;
      case "toast":
        showToast(String(message.message || ""));
        break;
      case "openSettings":
        vscode.postMessage({ type: "openSettings" });
        break;
      case "reset":
        resetViews();
        break;
      default:
        break;
    }
  });

  function handleQuick(message) {
    state.absolutePath = String(message.absolutePath || "");
    state.line = Number(message.line || 1);
    els.subtitle.textContent = String(message.filePath || "");
    els.subtitle.title = String(message.filePath || "");
    els.meta.innerHTML = String(message.metaHtml || "");
    if (message.locatorHtml) {
      els.locator.innerHTML = String(message.locatorHtml);
    }
    els.quickBody.innerHTML = String(message.html || "");
    els.contextBody.innerHTML = String(message.contextHtml || "");
    els.contextChars.textContent = message.contextChars
      ? " · 约 " + Number(message.contextChars).toLocaleString() + " 字符"
      : "";
    state.deepEnabled = true;
    els.deepTab.disabled = false;
    els.deepTab.classList.toggle("is-muted", !message.deepAvailable && message.source !== "ai");

    if (message.source === "ai") {
      setBadge("完成", "done");
      setDeepStatus("已完成", "done");
      if (message.deepHtml) {
        els.deepBody.innerHTML = String(message.deepHtml);
      }
      if (!state.userPickedTab) {
        setTab("deep", false);
      }
    } else if (message.deepAvailable) {
      setBadge("准备中", "running");
      setDeepStatus("正在读取项目上下文…", "running");
      if (state.activeTab === "deep" && !els.deepBody.innerHTML.trim()) {
        els.deepBody.innerHTML = skeletonHtml();
      }
    } else {
      setBadge("未配置", "");
      setDeepStatus("当前仅使用本地结构分析", "done");
      if (state.activeTab === "deep") {
        showDeepUnavailable(message.providerReason);
      }
    }

    if (state.activeTab === "quick") {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }

  function handleDeepStatus(status) {
    state.deepState = status.state || "idle";
    state.deepEnabled = true;
    els.deepTab.disabled = false;

    if (status.state === "done") {
      setBadge("完成", "done");
      setDeepStatus(status.message || "已完成", "done");
      if (!els.deepBody.innerHTML.trim()) {
        els.deepBody.innerHTML = skeletonHtml();
      }
    } else if (status.state === "error") {
      setBadge("失败", "error");
      setDeepStatus(status.message || "生成失败", "error");
    } else if (status.state === "streaming" || status.state === "warming") {
      setBadge("生成中", "running");
      setDeepStatus(status.message || "正在生成深度解读…", "running");
      if (state.activeTab === "deep" && !els.deepBody.innerHTML.trim()) {
        els.deepBody.innerHTML = skeletonHtml();
      }
    } else if (status.state === "unavailable") {
      setBadge("未配置", "");
      showDeepUnavailable(status.message);
    } else if (status.state === "idle") {
      setBadge("已暂停", "");
      setDeepStatus(status.message || "已暂停", "done");
    }
  }

  function handleDeepChunk(message) {
    state.deepState = "streaming";
    state.deepEnabled = true;
    els.deepTab.disabled = false;
    els.deepError.classList.add("hidden");
    const wasAtBottom = isNearBottom();
    els.deepBody.innerHTML = String(message.html || "");
    setBadge("生成中", "running");
    setDeepStatus(
      "正在生成… " + Number(message.length || 0).toLocaleString() + " 字符",
      "running",
    );
    if (!state.userPickedTab) {
      setTab("deep", false);
    }
    if (wasAtBottom) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    }
  }

  function handleDeepDone(message) {
    state.deepState = "done";
    state.deepEnabled = true;
    els.deepTab.disabled = false;
    els.deepError.classList.add("hidden");
    if (message.html) {
      els.deepBody.innerHTML = String(message.html);
    }
    setBadge("完成", "done");
    setDeepStatus(message.message || "深度解读已生成", "done");
    if (!state.userPickedTab) {
      setTab("deep", false);
    }
  }

  function handleDeepError(message) {
    state.deepState = "error";
    state.deepEnabled = true;
    els.deepTab.disabled = false;
    const text = String(message.message || "深度解读失败");
    setBadge("失败", "error");
    setDeepStatus(text, "error");
    els.deepError.classList.remove("hidden");
    els.deepError.innerHTML =
      "<p>" +
      escapeHtml(text) +
      '</p><p><button class="text-button" data-action="retry">重新尝试</button> · <button class="text-button" data-action="configure">配置模型</button></p>';
    const retry = els.deepError.querySelector('[data-action="retry"]');
    if (retry) {
      retry.addEventListener("click", () => vscode.postMessage({ type: "retry" }));
    }
    const configure = els.deepError.querySelector('[data-action="configure"]');
    if (configure) {
      configure.addEventListener("click", () => vscode.postMessage({ type: "configure" }));
    }
    if (!state.userPickedTab) {
      setTab("deep", false);
    }
  }

  function handleDeepUnavailable(message) {
    state.deepState = "unavailable";
    setBadge("未配置", "");
    setDeepStatus("未配置深度解读模型", "done");
    showDeepUnavailable(message.message);
    if (!state.userPickedTab && state.activeTab === "deep") {
      setTab("deep", false);
    }
  }

  function showDeepUnavailable(reason) {
    state.deepState = "unavailable";
    els.deepError.classList.remove("hidden");
    els.deepError.innerHTML =
      '<div class="callout warning"><p>' +
      escapeHtml(
        reason ||
          "当前为本地结构分析。配置 DeepSeek / OpenAI / Ollama 后，可让模型结合项目结构给出更深入的解读。",
      ) +
      '</p><p><button class="text-button" data-action="configure">配置模型</button> · <button class="text-button" data-action="settings">打开设置</button></p></div>';
    const configure = els.deepError.querySelector('[data-action="configure"]');
    if (configure) {
      configure.addEventListener("click", () => vscode.postMessage({ type: "configure" }));
    }
    const settings = els.deepError.querySelector('[data-action="settings"]');
    if (settings) {
      settings.addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));
    }
  }

  function setTab(tab, userPicked) {
    if (tab === "deep" && !state.deepEnabled) {
      return;
    }
    state.activeTab = tab;
    if (userPicked) {
      state.userPickedTab = true;
    }
    els.quickTab.classList.toggle("active", tab === "quick");
    els.deepTab.classList.toggle("active", tab === "deep");
    els.viewQuick.classList.toggle("active", tab === "quick");
    els.viewDeep.classList.toggle("active", tab === "deep");
    if (tab === "deep" && state.deepState === "unavailable") {
      showDeepUnavailable();
    }
    vscode.setState({ tab, path: state.absolutePath });
  }

  function setBadge(text, kind) {
    els.deepBadge.textContent = text;
    els.deepBadge.className = "badge" + (kind ? " " + kind : "");
  }

  function setDeepStatus(text, kind) {
    els.deepStatusText.textContent = text;
    els.deepStatusBar.className = "status-bar" + (kind ? " " + kind : "");
  }

  function resetViews() {
    els.subtitle.textContent = "正在读取项目结构…";
    els.meta.innerHTML = '<span class="pill">读取上下文中…</span>';
    els.locator.innerHTML = locatorSkeleton();
    els.quickBody.innerHTML = skeletonHtml();
    els.deepBody.innerHTML = "";
    els.contextBody.innerHTML = "";
    els.contextChars.textContent = "";
    els.deepError.classList.add("hidden");
    state.userPickedTab = false;
    state.deepState = "idle";
    setTab("quick", false);
    setBadge("准备中", "running");
    setDeepStatus("正在读取项目上下文…", "running");
  }

  function isNearBottom() {
    return (
      window.scrollY + window.innerHeight >=
      document.documentElement.scrollHeight - 140
    );
  }

  function showToast(message) {
    if (!message) {
      return;
    }
    els.toast.textContent = message;
    els.toast.classList.add("visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      els.toast.classList.remove("visible");
    }, 2200);
  }

  function skeletonHtml() {
    return '<div class="skeleton"><span></span><span></span><span></span><span></span></div>';
  }

  function locatorSkeleton() {
    return '<div class="locator-loading"><span></span><span></span><span></span></div>';
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const saved = vscode.getState();
  if (saved && saved.tab === "deep") {
    state.userPickedTab = true;
  }

  vscode.postMessage({ type: "ready" });
})();
