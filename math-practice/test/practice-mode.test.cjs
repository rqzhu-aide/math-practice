'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const directory = path.resolve(__dirname, '..');
const answers = require('../answer-check.js');

class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.hidden = true; this.disabled = false;
    this.dataset = {}; this.attributes = {}; this.listeners = {}; this.children = []; this.style = {};
    const classes = new Set();
    this.classList = {add: (...values) => values.forEach(value => classes.add(value)), remove: value => classes.delete(value), toggle: (value, active) => active ? classes.add(value) : classes.delete(value)};
  }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); }
  focus() {}
  scrollIntoView() {}
  reportValidity() { return true; }
  querySelectorAll() { return []; }
  async emit(name) { if (this.listeners[name]) await this.listeners[name]({target: this, preventDefault() {}}); }
}
function environment(file, extras = {}) {
  const elements = new Map();
  const root = new Element();
  const node = id => { if (!elements.has(id)) { const value = new Element(); root.appendChild(value); elements.set(id, value); } return elements.get(id); };
  const window = {MathPracticeAnswers: answers, addEventListener() {}};
  const context = vm.createContext({window, document: {getElementById: node, addEventListener() {}, body: new Element(), createElement: () => new Element(), createTextNode: text => Object.assign(new Element(), {textContent: text, nodeType: 3})},
    location: {protocol: 'http:'}, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => { throw new Error('Unexpected network request'); }, ...extras});
  vm.runInContext(fs.readFileSync(path.join(directory, file), 'utf8'), context, {filename: file});
  return {node, window, context};
}
function feedback(options = {}) {
  const requests = [];
  const env = environment('practice-feedback.js', {location: {protocol: options.protocol || 'http:'}});
  const question = options.question || {id: 'sample', responseType: 'numeric', answer: '0.5'};
  const answer = options.answer || '1/2';
  const o = {
    question: () => question, answer: () => answer, draft: new Element(), note: new Element(),
    panel: new Element(), panelStatus: new Element(), results: new Element(), announce: new Element(),
    el: (_tag, _class, text) => Object.assign(new Element(), {textContent: text}), percent: String,
    typeset() {}, connection() {}, collapse() {}, setRunning(value) { o.running = value; }, save() {},
    submitted() {}, updated() {}, checkAnswer: answers.check, classifyAnswer: answers.classify,
    services: () => options.services || {decision: false, inference: false},
    waitServices: options.waitServices
  };
  o.draft.value = options.thoughts === undefined ? 'One half equals five tenths.' : options.thoughts;
  const instance = new env.window.MathPracticeFeedback(o);
  instance.post = async (url, body) => { requests.push({url, body}); return options.reply(url, body); };
  return {...env, instance, requests, o};
}

for (const protocol of ['file:', 'http:']) {
  test(`${protocol} practice checks a correct answer without models or thinking`, async () => {
    const f = feedback({protocol, thoughts: ''});
    await f.instance.submit();
    assert.match(f.node('answerFeedback').textContent, /Correct\./);
    assert.match(f.node('reasoningFeedback').textContent, /Thinking: Not checked\./);
    assert.equal(f.node('submissionMark').dataset.result, 'review');
    assert.equal(f.node('tutorRetry').hidden, true);
    assert.equal(f.node('hintToggle').hidden, true);
    assert.equal(f.o.running, false);
    assert.deepEqual(f.requests, []);
  });
}
test('wrong exact answers show a cross without attempting a tutor', async () => {
  const f = feedback({answer: '2'});
  await f.instance.submit();
  assert.equal(f.node('submissionMark').dataset.result, 'wrong');
  assert.match(f.node('reasoningFeedback').textContent, /Not checked/);
  assert.deepEqual(f.requests, []);
});
test('answer forms remain partial and unsupported symbolic work remains unverified', async () => {
  const partial = feedback({question: {id: 'decimal', responseType: 'numeric', answer: '0.5', answerForm: 'decimal'}});
  await partial.instance.submit();
  assert.match(partial.node('answerFeedback').textContent, /Partially correct/);
  assert.match(partial.node('clarification').textContent, /decimal numeral/);
  assert.equal(partial.node('submissionMark').dataset.result, 'review');
  const unknown = feedback({question: {id: 'symbolic', responseType: 'short', answer: 'x+x'}, answer: '2x'});
  await unknown.instance.submit();
  assert.match(unknown.node('answerFeedback').textContent, /Not checked automatically/);
  assert.equal(unknown.node('submissionMark').dataset.result, 'review');
});
test('speech learning signals are skipped without a decision model', async () => {
  const f = feedback();
  f.instance.evidence = {transcript: 'My original thinking.', signals: null};
  await f.instance.checkSignals();
  assert.equal(f.o.panelStatus.textContent, 'Decision model not configured');
  assert.equal(f.o.results.children.length, 1);
  assert.deepEqual(f.requests, []);
});
test('learning signals accept a decision connection disabled after the page loaded', async () => {
  const f = feedback({services: {decision: true, inference: false}, reply(_url, body) {
    return {...body, decisionConfigured: false, signals: []};
  }});
  f.instance.evidence = {transcript: 'My original thinking.', signals: null};
  await f.instance.checkSignals();
  assert.equal(f.requests.length, 1);
  assert.equal(f.o.panel.dataset.state, 'idle');
  assert.equal(f.o.panelStatus.textContent, 'Decision model not configured');
  assert.equal(f.o.results.children.length, 1);
  assert.equal(f.o.results.children[0].children.length, 0);
});
test('configured inference reviews work when the decision model is absent', async () => {
  const f = feedback({services: {decision: false, inference: true}, reply(url, body) {
    if (url === '/api/assessment') return {...body, answerCategory: 'correct', answerCorrect: true,
      category: 'cannot_judge', modelUsed: false, decisionConfigured: false, inferenceConfigured: true};
    return {...body, answerCategory: 'correct', answerCorrect: true, category: 'correct', hint: '', clarification: ''};
  }});
  await f.instance.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.requests.map(r => r.url), ['/api/assessment', '/api/tutor']);
  assert.equal(f.node('submissionMark').dataset.result, 'correct');
});
test('assessment flags prevent tutor requests after a connection is disabled', async () => {
  const f = feedback({services: {decision: true, inference: true}, reply(_url, body) {
    return {...body, answerCategory: 'correct', answerCorrect: true, category: 'cannot_judge',
      decisionConfigured: false, inferenceConfigured: false, modelUsed: false};
  }});
  await f.instance.submit();
  assert.equal(f.requests.length, 1);
  assert.match(f.node('reasoningFeedback').textContent, /Not checked/);
  assert.equal(f.node('tutorRetry').hidden, true);
  assert.equal(f.node('submissionMark').dataset.result, 'review');
});
test('an unconfigured tutor response does not create a failed review or retry', async () => {
  const f = feedback({services: {decision: false, inference: true}, reply(url, body) {
    if (url === '/api/tutor') return {configured: false, inferenceConfigured: false};
    return {...body, answerCategory: 'correct', answerCorrect: true, category: 'cannot_judge',
      decisionConfigured: false, inferenceConfigured: true};
  }});
  await f.instance.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.node('reasoningFeedback').textContent, /Not checked/);
  assert.equal(f.node('tutorRetry').hidden, true);
  assert.equal(f.node('tutorStatus').hidden, true);
});
test('submission waits for pending configuration and ignores a stale submission', async () => {
  let finish;
  const f = feedback({waitServices: () => new Promise(resolve => { finish = resolve; })});
  const submission = f.instance.submit();
  f.instance.clear(); finish(); await submission;
  assert.equal(f.instance.mathState, 'idle');
  assert.equal(f.node('workFeedback').hidden, true);
  assert.deepEqual(f.requests, []);
});
test('microphone capture cannot start without a configured speech service', async () => {
  let captures = 0;
  const env = environment('speech-input.js', {navigator: {mediaDevices: {getUserMedia() { captures++; }}}});
  const o = Object.fromEntries(['record', 'recordLabel', 'recordTime', 'recordProgress', 'cancel', 'retry', 'status', 'draft'].map(id => [id, new Element()]));
  Object.assign(o, {isConfigured: () => false, isEnabled: () => true, isAssessing: () => false, onState() {}});
  const speech = new env.window.MathPracticeSpeech(o);
  assert.equal(o.record.disabled, true);
  assert.match(o.status.textContent, /Speech is not configured/);
  await speech.start();
  assert.equal(captures, 0);
  assert.equal(speech.state, 'idle');
  o.isConfigured = () => true; speech.sync();
  assert.equal(o.record.disabled, false);
  assert.equal(o.status.textContent, '');
});

function settingsEnvironment() {
  const requests = [];
  const section = () => ({bases: [], model: '', keyConfigured: false});
  let saved = {decision: section(), speech: section(), inference: {...section(), provider: 'api', effort: 'medium'}};
  const env = environment('settings.js', {fetch: async (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    requests.push({url, body});
    if (url === '/api/settings' && body) saved = {...saved, ...body};
    let value = saved;
    if (url === '/api/settings/compare') value = {different: false, changedSections: []};
    if (url === '/api/connections/openai') value = {state: 'signed_out', message: 'Sign in when ready.', canTest: false};
    return {ok: true, json: async () => value};
  }});
  return {...env, requests};
}
test('blank settings load and save one model independently without a Codex probe', async () => {
  const s = settingsEnvironment();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.node('inferenceProvider').value, 'api');
  assert.equal(s.node('decisionBadge').textContent, 'Not configured');
  assert.equal(s.node('decisionBases').disabled, false);
  s.node('decisionBases').value = 'http://localhost:8000';
  s.node('decisionModel').value = 'decision-test';
  await s.node('decisionForm').emit('submit');
  const writes = s.requests.filter(r => r.url === '/api/settings' && r.body);
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].body), ['decision']);
  assert.equal(writes[0].body.decision.model, 'decision-test');
  assert.equal(s.node('speechBases').value, '');
  assert.equal(s.requests.some(r => r.url.includes('/connections/openai')), false);
});
test('testing optional blank settings skips model calls and Codex requires selection', async () => {
  const s = settingsEnvironment();
  await new Promise(resolve => setImmediate(resolve));
  await s.node('testConnections').emit('click');
  assert.match(s.node('pageStatus').textContent, /No models are configured/);
  assert.equal(s.requests.some(r => r.url.endsWith('/test')), false);
  assert.equal(s.requests.some(r => r.url.includes('/connections/openai')), false);
  s.node('inferenceProvider').value = 'codex';
  await s.node('inferenceProvider').emit('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.requests.filter(r => r.url === '/api/connections/openai').length, 1);
});
test('the shipped page loads the processed CN bank and permits blank connection fields', () => {
  const index = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(directory, 'settings.html'), 'utf8');
  assert.match(index, /<script src="\.\.\/cn-math-bank\/bank\.js"><\/script>/);
  assert.doesNotMatch(index, /<script src="amc-bank\.js"/);
  assert.doesNotMatch(settings, /\brequired\b/);
  const inline = index.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(inline, 'Practice bootstrap is present');
  new vm.Script(inline[1], {filename: 'index.html'});
  for (const match of settings.matchAll(/placeholder="(https?:\/\/[^\"]+)"/g)) assert.match(match[1], /^http:\/\/localhost:/);
});

for (const mode of ['file', 'backend without models', 'static HTTP']) {
  test(`full page supports browsing, answer checks, and solutions with ${mode}`, async () => {
    const requests = [], storage = new Map();
    const env = environment('practice-feedback.js', {location: {protocol: mode === 'file' ? 'file:' : 'http:'},
      localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
      fetch: async url => {
        requests.push(url);
        if (mode === 'static HTTP') throw new TypeError('No API on a static server');
        assert.match(url, /^\/api\/status\/(decision|speech|inference)$/);
        return {ok: true, json: async () => ({configured: false, ready: false, label: 'Not configured'})};
      }
    });
    env.window.CN_MATH_BANK = {id: 'cn-math', label: 'Sample curriculum', questions: [{id: 'cn-sample',
      bank: 'cn-math', level: 'Primary', grade: 1, unit: 'Primary 1', batch: 'number', number: 1,
      topic: {label: 'Numbers'}, responseType: 'numeric', answer: '2', choices: {},
      question: 'What is 1 + 1?', solution: 'Add one to one.'}]};
    vm.runInContext(fs.readFileSync(path.join(directory, 'speech-input.js'), 'utf8'), env.context);
    const index = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
    vm.runInContext(index.match(/<script>\s*([\s\S]*?)<\/script>/)[1], env.context);
    await new Promise(resolve => setImmediate(resolve));
    await env.node('beginPractice').emit('click');
    assert.equal(env.node('poolDisplay').hidden, false);
    assert.equal(env.node('thoughtsCard').hidden, false);
    assert.equal(env.node('speechRecord').disabled, true);
    env.node('freeAnswer').value = '2';
    await env.node('freeAnswer').emit('input');
    await env.node('thoughtsSubmit').emit('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.match(env.node('answerFeedback').textContent, /Correct\./);
    assert.match(env.node('reasoningFeedback').textContent, /Not checked/);
    assert.equal(env.node('submissionMark').dataset.result, 'review');
    const find = (node, className) => node.className === className ? node : node.children.map(child => find(child, className)).find(Boolean);
    await find(env.node('poolDisplay'), 'sol-btn').emit('click');
    assert.equal(env.node('solModal').hidden, false);
    assert.equal(env.node('solBody').children[0].children[0].textContent, 'Reference answer: 2');
    assert.equal(env.node('solBody').children[0].children[1].children[0].textContent, 'Add one to one.');
    assert.equal(requests.length, mode === 'file' ? 0 : 3);
  });
}
