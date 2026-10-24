(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var sections = ["decision", "speech", "inference"];
  var loaded = false, account = null, poll = null, accountBusy = false;
  var initial = {}, working = {};
  var checkingAll = false, configurationBusy = false;
  var fileComparison = null, comparedSnapshot = null, comparisonTimer = null, comparisonVersion = 0;
  var testLabels = {decision: "Test decision model", speech: "Test speech to text", inference: "Test inference model"};

  async function request(path, body) {
    var response;
    try {
      response = await fetch(path, body === undefined ? {} : {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)
      });
    } catch (_) { throw new Error("The local engine is unavailable. Open Start Math Practice.cmd beside index.html, then return here."); }
    var json;
    try { json = await response.json(); } catch (_) { throw new Error("The local backend did not respond. Start the latest launcher, then reload this page."); }
    if (!response.ok) throw new Error(json.error && json.error.message || "The request could not finish. Try again.");
    return json;
  }
  function message(id, text, state) {
    $(id).textContent = text;
    $(id).dataset.state = state || "";
  }
  function buttonId(action, section) { return action + section[0].toUpperCase() + section.slice(1); }
  function payload(section) {
    var value = {
      bases: $(section + "Bases").value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean),
      model: $(section + "Model").value.trim(), apiKey: $(section + "Key").value
    };
    if (section === "inference") {
      value.provider = $("inferenceProvider").value;
      value.effort = $("inferenceEffort").value;
    }
    var patch = {}; patch[section] = value; return patch;
  }
  function serialize(section) { return JSON.stringify(payload(section)); }
  function configured(section) {
    var value = payload(section)[section];
    return !!value.model && (section === 'inference' && value.provider === 'codex' || value.bases.length > 0);
  }
  function configuration() {
    var value = {};
    sections.forEach(function (section) { Object.assign(value, payload(section)); });
    return value;
  }
  function edited(section) { return loaded && serialize(section) !== initial[section]; }
  function dirty(section) {
    if (!loaded) return false;
    if (fileComparison && comparedSnapshot === JSON.stringify(configuration())) return fileComparison.changedSections.indexOf(section) !== -1;
    return edited(section);
  }
  async function compareConfiguration() {
    if (!loaded || configurationBusy) return;
    var snapshot = JSON.stringify(configuration()), version = ++comparisonVersion;
    try {
      var result = await request("/api/settings/compare", JSON.parse(snapshot));
      if (version !== comparisonVersion || snapshot !== JSON.stringify(configuration()) || configurationBusy) return;
      var wasDifferent = fileComparison && fileComparison.different;
      fileComparison = result; comparedSnapshot = snapshot;
      updateToolbar();
      if (result.different && !sections.some(edited)) {
        message("pageStatus", "The displayed configuration differs from config.json. Save Configuration to keep these values, or Load Configuration to use the file.");
      } else if (!result.different && (wasDifferent || sections.some(edited))) {
        message("pageStatus", "Configuration matches config.json.");
      }
    } catch (error) {
      if (version !== comparisonVersion || snapshot !== JSON.stringify(configuration()) || configurationBusy) return;
      fileComparison = null; comparedSnapshot = null;
      updateToolbar(); message("pageStatus", "Could not compare with config.json. " + error.message, "error");
    }
  }
  function scheduleComparison() {
    ++comparisonVersion;
    if (comparisonTimer) clearTimeout(comparisonTimer);
    comparisonTimer = setTimeout(function () { comparisonTimer = null; compareConfiguration(); }, 250);
  }
  function toolbarBusy() {
    return checkingAll || configurationBusy || sections.some(function (section) { return !!working[section]; });
  }
  function updateToolbar() {
    var blocked = toolbarBusy();
    $("loadConfiguration").disabled = blocked;
    $("testConnections").disabled = !loaded || blocked;
    $("saveConfiguration").hidden = !sections.some(dirty);
    $("saveConfiguration").disabled = !loaded || blocked;
  }
  function accountControls() {
    var unavailable = account && account.state === "unavailable";
    var blocked = accountBusy || !!working.inference || !loaded;
    $("refreshOpenai").disabled = blocked;
    $("loginOpenai").disabled = blocked || !!unavailable;
    $("cancelLogin").disabled = blocked;
  }
  function updateProvider() {
    var api = $("inferenceProvider").value === "api";
    $("codexConnection").hidden = api;
    $("inferenceApiFields").hidden = !api;
    $("effortField").hidden = api;
    $("inferenceBases").required = false;
    ["inferenceBases", "inferenceKey"].forEach(function (id) { $(id).disabled = !loaded || !!working.inference || !api; });
    $("inferenceEffort").disabled = !loaded || !!working.inference || api;
    $("testInference").disabled = !loaded || !!working.inference || (!api && (!account || !account.canTest));
    accountControls();
  }
  function busy(section, state) {
    working[section] = state;
    $(section + "Form").querySelectorAll("button, input, textarea, select").forEach(function (node) { node.disabled = state || !loaded; });
    if (section === "inference") updateProvider();
    updateToolbar();
  }
  function keyHelp(section, configured) {
    $(section + "KeyHelp").textContent = configured ? "A key is configured. Leave blank to keep it." : "Enter a key if your service requires one.";
  }
  function apply(settings) {
    if (!settings.decision || !settings.speech || !settings.inference) throw new Error("Restart the local launcher to enable all three model connections, then reload this page.");
    fileComparison = null; comparedSnapshot = null; ++comparisonVersion;
    if (comparisonTimer) { clearTimeout(comparisonTimer); comparisonTimer = null; }
    sections.forEach(function (section) {
      $(section + "Bases").value = settings[section].bases.join("\n");
      $(section + "Model").value = settings[section].model;
      $(section + "Key").value = "";
      keyHelp(section, settings[section].keyConfigured);
    });
    $("inferenceProvider").value = settings.inference.provider;
    $("inferenceEffort").value = settings.inference.effort;
    sections.forEach(function (section) {
      message(section + "Badge", configured(section) ? "Not tested" : "Not configured");
    });
    sections.forEach(function (section) { initial[section] = serialize(section); });
    loaded = true;
    message("pageStatus", settings.notice || "Loaded config.json. Credentials stay in the local engine.");
  }
  function renderAccount(value) {
    account = value;
    message("accountStatus", value.message);
    var waiting = value.state === "waiting";
    $("loginOpenai").hidden = waiting || value.state === "signed_in";
    $("cancelLogin").hidden = !waiting;
    updateProvider();
    var validLink = value.loginUrl === "https://auth.openai.com/codex/device";
    $("deviceLogin").hidden = !waiting || !validLink || !value.userCode;
    $("deviceCode").textContent = value.userCode || "";
    if (validLink) $("deviceLink").href = value.loginUrl;
    else $("deviceLink").removeAttribute("href");
    if (poll) { clearTimeout(poll); poll = null; }
    if (waiting) poll = setTimeout(refreshAccount, 3000);
  }
  async function refreshAccount() {
    if (accountBusy || $("inferenceProvider").value !== 'codex') return;
    accountBusy = true; accountControls();
    try { renderAccount(await request("/api/connections/openai")); }
    catch (error) { message("accountStatus", error.message, "error"); }
    finally { accountBusy = false; accountControls(); }
  }
  async function save(section, event) {
    event.preventDefault();
    if (!loaded) return;
    var patch = payload(section);
    busy(section, true); message(section + "Result", "Saving…");
    try {
      var settings = await request("/api/settings", patch);
      // Saving one card must preserve unsaved edits in the other cards.
      $(section + "Key").value = "";
      keyHelp(section, settings[section].keyConfigured);
      initial[section] = serialize(section);
      message(section + "Badge", configured(section) ? "Not tested" : "Not configured");
      message(section + "Result", "Settings saved on this computer. Run a connection test when you are ready.", "ok");
      message("pageStatus", "Connection settings are saved to config.json.");
    } catch (error) { message(section + "Result", error.message, "error"); $(section + "Result").focus(); }
    finally { busy(section, false); compareConfiguration(); }
  }
  async function test(section) {
    if (!loaded || !$(section + "Form").reportValidity()) return false;
    if (!configured(section)) {
      message(section + "Badge", "Not configured");
      message(section + "Result", "This connection is optional. Enter its server address and model ID to test it, or leave both blank to practice without it.");
      return null;
    }
    var snapshot = payload(section), button = $(buttonId("test", section));
    busy(section, true); message(section + "Result", "Running a short connection test…");
    message(section + "Badge", "Testing"); button.textContent = "Testing…";
    try {
      var result = await request("/api/settings/" + section + "/test", snapshot);
      var detail = result.model + (result.effort ? " · " + result.effort + " reasoning" : "") + " · " + (result.elapsedMs / 1000).toFixed(1) + " s";
      message(section + "Result", result.message + " " + detail + (dirty(section) ? ". These settings are not saved yet." : ""), "ok");
      message(section + "Badge", "Test passed", "ok");
      return true;
    } catch (error) {
      message(section + "Result", error.message, "error"); message(section + "Badge", "Test failed", "error"); $(section + "Result").focus();
      return false;
    } finally { busy(section, false); button.textContent = testLabels[section]; }
  }
  async function loadConfiguration() {
    if (toolbarBusy()) return;
    if (sections.some(function (section) { return edited(section) && dirty(section); }) && !window.confirm("Load config.json and discard the unsaved edits on this page?")) return;
    configurationBusy = true;
    sections.forEach(function (section) { busy(section, true); });
    $("loadConfiguration").textContent = "Loading…";
    message("pageStatus", "Loading configuration…");
    try {
      apply(await request("/api/settings/reload", {}));
      sections.forEach(function (section) {
        message(section + "Badge", configured(section) ? "Not tested" : "Not configured");
        message(section + "Result", configured(section) ? "Configuration loaded. Choose Test Connection to check it." : "No model is configured for this optional connection.");
      });
      if ($("inferenceProvider").value === 'codex') await refreshAccount();
    } catch (error) { message("pageStatus", error.message, "error"); }
    finally {
      configurationBusy = false;
      sections.forEach(function (section) { busy(section, false); });
      $("loadConfiguration").textContent = "Load Configuration";
      compareConfiguration();
    }
  }
  async function saveConfiguration() {
    if (!loaded || toolbarBusy()) return;
    var changed = sections.filter(dirty);
    if (!changed.length || !sections.every(function (section) { return $(section + "Form").reportValidity(); })) return;
    var patch = configuration();
    configurationBusy = true;
    sections.forEach(function (section) { busy(section, true); });
    $("saveConfiguration").textContent = "Saving…";
    message("pageStatus", "Saving configuration…");
    try {
      apply(await request("/api/settings", patch));
      message("pageStatus", "Configuration saved to config.json.", "ok");
      changed.forEach(function (section) { message(section + "Result", "Configuration saved. Choose Test Connection to check it.", "ok"); });
    } catch (error) { message("pageStatus", error.message, "error"); }
    finally {
      configurationBusy = false;
      sections.forEach(function (section) { busy(section, false); });
      $("saveConfiguration").textContent = "Save Configuration";
      compareConfiguration();
    }
  }
  async function checkConnections() {
    if (!loaded || toolbarBusy()) return;
    if (!sections.every(function (section) { return $(section + "Form").reportValidity(); })) return;
    checkingAll = true; updateToolbar();
    $("testConnections").textContent = "Testing…";
    message("pageStatus", "Testing configured connections…");
    try {
      var results = await Promise.all(sections.map(test));
      var passed = results.filter(Boolean).length;
      var attempted = results.filter(function (result) { return result !== null; }).length;
      var next = sections.some(dirty) ? " Save Configuration to use these settings." : " Ready to practice.";
      message("pageStatus", !attempted ? "No models are configured. Answer checks and solutions are ready to use." : passed + " of " + attempted + " configured connections passed." + (passed < attempted ? " Check the results below." : next), passed === attempted ? "ok" : "error");
    } catch (error) { message("pageStatus", error.message, "error"); }
    finally {
      checkingAll = false; updateToolbar();
      $("testConnections").textContent = "Test Connection";
    }
  }
  async function accountAction(route) {
    if (accountBusy) return;
    accountBusy = true; accountControls();
    message("accountStatus", route === "login" ? "Preparing OpenAI sign-in…" : "Canceling sign-in…");
    try { renderAccount(await request("/api/connections/openai/" + route, {})); }
    catch (error) { message("accountStatus", error.message, "error"); }
    finally { accountBusy = false; accountControls(); }
  }
  sections.forEach(function (section) {
    $(section + "Form").addEventListener("submit", save.bind(null, section));
    $(section + "Form").addEventListener("input", function () {
      message(section + "Badge", "Not tested");
      message(section + "Result", "Settings changed. Save to use this connection, or test the values entered here.");
      message("pageStatus", sections.some(dirty) ? "Unsaved changes. Save Configuration to apply them, or Test Connection to check them." : "Configuration matches the saved settings. Choose Test Connection to check it.");
      updateToolbar();
      scheduleComparison();
    });
    $(buttonId("test", section)).addEventListener("click", test.bind(null, section));
  });
  $("inferenceProvider").addEventListener("change", function () { updateProvider(); if ($("inferenceProvider").value === 'codex') refreshAccount(); });
  $("loadConfiguration").addEventListener("click", loadConfiguration);
  $("testConnections").addEventListener("click", checkConnections);
  $("saveConfiguration").addEventListener("click", saveConfiguration);
  $("refreshOpenai").addEventListener("click", refreshAccount);
  $("loginOpenai").addEventListener("click", accountAction.bind(null, "login"));
  $("cancelLogin").addEventListener("click", accountAction.bind(null, "cancel"));
  $("copyCode").addEventListener("click", async function () {
    try { await navigator.clipboard.writeText($("deviceCode").textContent); $("copyCode").textContent = "Copied"; }
    catch (_) { message("accountStatus", "Select the sign-in code and copy it manually."); }
  });
  window.addEventListener("focus", compareConfiguration);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) compareConfiguration(); });
  window.addEventListener("beforeunload", function (event) { if (sections.some(function (section) { return edited(section) && dirty(section); })) { event.preventDefault(); event.returnValue = ""; } });
  sections.forEach(function (section) { busy(section, true); });
  request("/api/settings").then(function (settings) {
    apply(settings); sections.forEach(function (section) { busy(section, false); });
    if ($("inferenceProvider").value === 'codex') refreshAccount();
    compareConfiguration();
    if (window.location && new URLSearchParams(window.location.search).get("check") === "1") {
      if (window.history && window.history.replaceState) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      checkConnections();
    }
  }).catch(function (error) { working = {}; updateToolbar(); message("pageStatus", error.message, "error"); });
}());
