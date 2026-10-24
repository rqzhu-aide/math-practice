/* Original speech observations and submitted mathematical work stay separate. */
(function () {
  'use strict';
  class PracticeFeedback {
    constructor(options) {
      this.o = options; this.serial = 0; this.signalSerial = 0;
      this.mathRequest = null; this.tutorRequest = null; this.signalRequest = null;
      this.evidence = null; this.submitted = null; this.hint = ''; this.initialCategory = null; this.initialAnswerCategory = null; this.mathState = 'idle';
      this.serviceOverrides = {};
      this.n = {};
      for (const id of ['workFeedback', 'submissionMark', 'answerFeedback', 'reasoningFeedback', 'clarification', 'tutorStatus', 'hintToggle', 'hintBody', 'tutorRetry', 'reviewNote']) this.n[id] = document.getElementById(id);
      this.n.hintToggle.addEventListener('click', () => {
        if (!this.hint || this.edited()) return;
        const open = this.n.hintBody.hidden;
        this.n.hintBody.hidden = !open;
        this.n.hintBody.textContent = open ? this.hint : '';
        this.n.hintToggle.textContent = open ? 'Hide hint' : 'Show a hint';
        this.n.hintToggle.setAttribute('aria-expanded', String(open));
        if (open) this.o.typeset(this.n.hintBody);
      });
      this.n.tutorRetry.addEventListener('click', () => {
        if (!this.edited() && this.initialCategory) this.requestTutor(this.initialCategory, this.initialAnswerCategory, this.serial);
      });
    }
    async post(url, body, controller) {
      const timer = setTimeout(() => controller.abort(), 155000);
      try {
        const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: controller.signal});
        let value;
        try { value = JSON.parse(await response.text()); } catch (_) { throw new Error('The service returned an unreadable response. Try again.'); }
        if (!response.ok) throw new Error(value && value.error && value.error.message || 'The check could not finish. Try again.');
        return value;
      } finally { clearTimeout(timer); }
    }
    services() {
      return Object.assign({decision: false, inference: false}, this.o.services ? this.o.services() : {}, this.serviceOverrides);
    }
    async waitServices() { if (this.o.waitServices) await this.o.waitServices(); }
    updateServices(value) {
      for (const role of ['decision', 'inference']) {
        if (typeof value[role + 'Configured'] === 'boolean') this.serviceOverrides[role] = value[role + 'Configured'];
      }
    }
    cancelMath() {
      this.serial++;
      if (this.mathRequest) this.mathRequest.abort();
      if (this.tutorRequest) this.tutorRequest.abort();
      this.mathRequest = null; this.tutorRequest = null;
      this.o.setRunning(false);
    }
    clear() {
      this.cancelMath(); this.signalSerial++;
      if (this.signalRequest) this.signalRequest.abort();
      this.signalRequest = null; this.evidence = null; this.submitted = null; this.hint = '';
      this.mathState = 'idle';
      this.showSubmissionMark();
      this.n.workFeedback.hidden = true;
    }
    restore(evidence) {
      if (!evidence || typeof evidence.transcript !== 'string' || !evidence.transcript.trim()) return;
      this.evidence = evidence;
      if (this.validSignals(evidence.signals)) this.renderSignals();
      else if (this.services().decision) this.signalError('Your original transcript is ready to check. Review its learning signals when ready.');
      else this.skipSignals();
    }
    recorded(transcript) {
      if (!transcript || !this.o.question()) return;
      this.evidence = {transcript, signals: null};
      this.o.save();
      this.checkSignals();
    }
    validSignals(signals) {
      return Array.isArray(signals) && signals.length === 3 && ['confidence', 'reasoning', 'engagement'].every((id, i) => {
        const s = signals[i];
        return s && s.id === id && typeof s.title === 'string' && typeof s.label === 'string' && typeof s.score === 'number' && Number.isFinite(s.score) && s.score >= 0 && s.score <= 1
          && Array.isArray(s.distribution) && s.distribution.every(d => typeof d.label === 'string' && typeof d.score === 'number' && Number.isFinite(d.score) && d.score >= 0 && d.score <= 1);
      });
    }
    async checkSignals() {
      const q = this.o.question(), evidence = this.evidence;
      if (!q || !evidence) return;
      await this.waitServices();
      if (this.evidence !== evidence || !this.o.question() || this.o.question().id !== q.id) return;
      if (!this.services().decision) { this.skipSignals(); return; }
      if (this.signalRequest) this.signalRequest.abort();
      const serial = ++this.signalSerial, controller = new AbortController(); this.signalRequest = controller;
      this.o.panel.dataset.state = 'loading'; this.o.panelStatus.textContent = 'From original speech, before edits';
      this.o.results.replaceChildren(this.o.el('p', 'signals-loading', 'Reading the original transcript for learning signals...'));
      this.o.collapse(false);
      try {
        const reply = await this.post('/api/learning-signals', {questionId: q.id, transcript: evidence.transcript}, controller);
        if (serial !== this.signalSerial) return;
        this.updateServices(reply);
        if (reply.decisionConfigured === false) { this.skipSignals(); return; }
        if (reply.questionId !== q.id || reply.transcript !== evidence.transcript || !this.validSignals(reply.signals)) throw new Error('Learning signals returned an incomplete result. Try the check again.');
        this.evidence = {transcript: evidence.transcript, signals: reply.signals}; this.o.save(); this.renderSignals();
        this.o.connection('decision', 'ok', 'Ready', 'The decision model assessed the original transcript.');
      } catch (error) {
        if (serial === this.signalSerial) this.signalError(error.name === 'AbortError' ? 'Learning signals took too long. Retry when ready.' : error instanceof TypeError ? 'Could not reach learning signals. Check the backend connection.' : error.message);
      } finally { if (serial === this.signalSerial) this.signalRequest = null; }
    }
    signalError(message) {
      if (!this.services().decision) { this.skipSignals(); return; }
      this.o.panel.dataset.state = 'error'; this.o.panelStatus.textContent = 'Original speech signals unavailable';
      const box = this.o.el('div', 'signals-error'); box.appendChild(this.o.el('p', null, message));
      const retry = this.o.el('button', 'ghost', 'Retry speech signals'); retry.type = 'button'; retry.addEventListener('click', () => this.checkSignals()); box.appendChild(retry);
      this.o.results.replaceChildren(box);
    }
    skipSignals() {
      this.o.panel.dataset.state = 'idle'; this.o.panelStatus.textContent = 'Decision model not configured';
      this.o.results.replaceChildren(this.o.el('p', 'signals-empty', 'Your transcript is saved. Add a decision model in Connections to check original speech for learning signals.'));
    }
    renderSignals() {
      const el = this.o.el, wrap = el('div', 'signals-result'), list = el('dl', 'signal-list');
      for (const signal of this.evidence.signals) {
        const row = el('div', 'signal-row'), value = el('dd'); row.appendChild(el('dt', null, signal.title));
        value.appendChild(el('span', null, signal.label)); const score = el('span', 'signal-probability', this.o.percent(signal.score));
        score.setAttribute('aria-label', 'Model probability ' + this.o.percent(signal.score)); value.appendChild(score); row.appendChild(value); list.appendChild(row);
      }
      wrap.appendChild(list);
      const details = el('details', 'signal-details'); details.appendChild(el('summary', null, 'All probabilities and original speech'));
      details.appendChild(el('p', null, 'These observations describe the original transcript, not mathematical accuracy or measured certainty about you.'));
      for (const signal of this.evidence.signals) {
        details.appendChild(el('strong', null, signal.title));
        for (const item of signal.distribution) { const row = el('div', 'signal-score'); row.appendChild(el('span', null, item.label)); row.appendChild(el('span', 'num', this.o.percent(item.score))); details.appendChild(row); }
      }
      details.appendChild(el('p', 'submitted-work', 'Original speech transcript: ' + this.evidence.transcript)); wrap.appendChild(details);
      this.o.results.replaceChildren(wrap); this.o.panel.dataset.state = 'ready'; this.o.panelStatus.textContent = 'From original speech, before edits';
      this.o.announce.textContent = 'Learning signals ready from your original speech.';
    }
    edited() {
      return !this.submitted || !this.o.question() || this.o.question().id !== this.submitted.question.id || this.o.answer() !== this.submitted.answer || this.o.draft.value.trim() !== this.submitted.thoughts;
    }
    revisionChanged() {
      const edited = this.edited();
      this.n.reviewNote.hidden = !this.submitted || !edited;
      this.n.reviewNote.textContent = this.submitted && edited ? 'This feedback belongs to your earlier try. Submit your changes for a fresh check.' : '';
      this.n.hintToggle.disabled = edited; this.n.tutorRetry.disabled = edited;
      if (edited) { this.n.hintBody.hidden = true; this.n.hintBody.textContent = ''; this.n.hintToggle.setAttribute('aria-expanded', 'false'); this.n.hintToggle.textContent = 'Show a hint'; }
    }
    async submit() {
      const question = this.o.question(), answer = this.o.answer(), thoughts = this.o.draft.value.trim();
      if (question && question.gradingStatus === 'disputed') {
        this.cancelMath(); this.submitted = {question, answer, thoughts}; this.mathState = 'ready';
        this.o.submitted(this.submitted); this.showNotGraded(question.gradingNote); this.o.updated();
        return;
      }
      if (!question || !answer) {
        this.o.note.textContent = !question ? 'Choose a problem first.' : 'Choose or enter an answer before submitting.';
        return;
      }
      this.cancelMath(); this.submitted = {question, answer, thoughts}; this.initialCategory = null; this.initialAnswerCategory = null; this.hint = '';
      this.serviceOverrides = {};
      this.mathState = 'loading';
      this.o.submitted(this.submitted); this.o.setRunning(true);
      const n = this.n; n.workFeedback.hidden = false;
      const exactCategory = this.o.classifyAnswer(question, answer);
      this.showAnswer(answer, this.o.checkAnswer(question, answer), exactCategory);
      this.showSubmissionMark('cannot_judge', exactCategory);
      n.reasoningFeedback.className = 'reasoning-feedback'; n.reasoningFeedback.textContent = 'Thinking: Checking your reasoning...';
      n.clarification.hidden = true; n.hintToggle.hidden = true; n.hintBody.hidden = true; n.hintBody.textContent = ''; n.tutorRetry.hidden = true; n.tutorStatus.hidden = true;
      if (exactCategory === 'partial') {
        n.clarification.hidden = false; n.clarification.textContent = window.MathPracticeAnswers.formFeedback(question, answer) || 'Complete or clarify your answer above, then submit again.';
      }
      n.hintToggle.setAttribute('aria-expanded', 'false'); n.hintToggle.textContent = 'Show a hint';
      this.revisionChanged();
      const serial = this.serial, controller = new AbortController(); this.mathRequest = controller;
      try {
        if (location.protocol !== 'file:' && thoughts) await this.waitServices();
        if (serial !== this.serial) return;
        const services = this.services();
        if (location.protocol === 'file:' || !thoughts || (!services.decision && !services.inference)) {
          this.mathState = 'ready';
          const message = location.protocol === 'file:' ? 'Start the local launcher and add a model in Connections for reasoning feedback.'
            : !thoughts && (services.decision || services.inference) ? 'Add your thinking and submit again for a reasoning review.'
            : 'Add a decision or inference model in Connections for reasoning feedback.';
          this.showUnchecked(message, exactCategory);
          return;
        }
        const value = await this.post('/api/assessment', {questionId: question.id, answer, thoughts}, controller);
        if (serial !== this.serial) return;
        if (value.questionId === question.id && value.answer === answer && value.gradingStatus === 'disputed' && value.answerCategory === 'not_graded' && value.answerCorrect === null) {
          this.mathState = 'ready'; this.showNotGraded(value.gradingNote); return;
        }
        this.reconcileForm(value);
        if (value.questionId !== question.id || value.answer !== answer || !this.validAnswer(value) || !['correct', 'wrong', 'partial', 'cannot_judge'].includes(value.category)) throw new Error('The answer and reasoning check returned an incomplete result. Try submitting again.');
        this.updateServices(value);
        this.showAnswer(answer, value.answerCorrect, value.answerCategory);
        if (!this.services().decision && !this.services().inference) this.showUnchecked('Add a decision or inference model in Connections for reasoning feedback.', value.answerCategory);
        else this.showVerdict(value.category, '', value.answerCategory, value.answerFormFeedback);
        this.mathState = 'ready';
        if (value.modelUsed) this.o.connection('decision', 'ok', 'Ready', 'The decision model checked the submitted work.');
        if (this.services().inference && (value.category !== 'correct' || value.answerCategory !== 'correct')) {
          this.initialCategory = value.category; this.initialAnswerCategory = value.answerCategory;
          this.requestTutor(value.category, value.answerCategory, serial);
        }
        this.revisionChanged();
      } catch (error) {
        if (serial !== this.serial) return;
        this.mathState = 'error';
        n.reasoningFeedback.textContent = 'Thinking: Not checked. The model check is unavailable. Your answer check above still applies.';
        this.o.note.textContent = error.name === 'AbortError' ? 'The check took too long. Submit again to retry.' : error instanceof TypeError ? 'Could not reach the backend. Start the local launcher and submit again.' : error.message;
      } finally {
        if (serial === this.serial) { this.mathRequest = null; this.o.setRunning(false); this.o.updated(); }
      }
    }
    showUnchecked(message, answerCategory) {
      const n = this.n;
      this.showSubmissionMark('cannot_judge', answerCategory);
      if (answerCategory === 'correct') n.submissionMark.setAttribute('aria-label', 'Correct answer; thinking not checked');
      n.reasoningFeedback.textContent = 'Thinking: Not checked. ' + message;
      n.reasoningFeedback.className = 'reasoning-feedback verdict-cannot_judge';
      n.hintToggle.hidden = true; n.hintBody.hidden = true; n.tutorRetry.hidden = true; n.tutorStatus.hidden = true;
      this.o.announce.textContent = n.answerFeedback.textContent + ' ' + n.reasoningFeedback.textContent;
    }
    validAnswer(value) {
      return ['correct', 'wrong', 'partial', 'cannot_judge'].includes(value.answerCategory)
        && value.answerCorrect === (value.answerCategory === 'correct' ? true : value.answerCategory === 'wrong' ? false : null);
    }
    reconcileForm(value) {
      const submitted = this.submitted;
      const message = window.MathPracticeAnswers.formFeedback(submitted.question, submitted.answer);
      if (message && value.answerCategory === 'correct') { value.answerCategory = 'partial'; value.answerCorrect = null; }
      if (message && value.answerCategory === 'partial') {
        value.answerFormFeedback = message;
        if (Object.prototype.hasOwnProperty.call(value, 'clarification')) {
          value.clarification = message;
          if (!value.hint) value.hint = 'Keep the same mathematical value and use the requested answer form.';
        }
      }
    }
    showNotGraded(note) {
      const n = this.n;
      this.showSubmissionMark();
      n.workFeedback.hidden = false;
      n.answerFeedback.textContent = 'Not graded: Disputed problem.'; n.answerFeedback.className = 'answer-feedback';
      n.reasoningFeedback.textContent = 'No score is assigned. You can still explore this problem.'; n.reasoningFeedback.className = 'reasoning-feedback';
      n.clarification.hidden = false; n.clarification.textContent = note || 'None of the printed choices answers this problem as written.';
      n.hintToggle.hidden = true; n.hintBody.hidden = true; n.hintBody.textContent = ''; n.tutorRetry.hidden = true; n.tutorStatus.hidden = true;
      this.o.announce.textContent = n.answerFeedback.textContent + ' ' + n.clarification.textContent;
    }
    showSubmissionMark(category, answerCategory) {
      const mark = this.n.submissionMark;
      const result = answerCategory === 'wrong' ? 'wrong' : !category ? '' : answerCategory === 'correct' && category === 'correct' ? 'correct' : 'review';
      const labels = {correct: 'Correct answer and thinking', wrong: 'Incorrect answer', review: answerCategory === 'correct' ? 'Correct answer; thinking needs review' : 'Answer needs review'};
      mark.dataset.result = result; mark.hidden = !result;
      mark.setAttribute('aria-label', labels[result] || '');
    }
    showAnswer(answer, correct, category) {
      category = category || (correct === null ? 'cannot_judge' : correct ? 'correct' : 'wrong');
      const label = this.submitted.question.responseType && this.submitted.question.responseType !== 'choice' ? 'Answer: ' : 'Answer ' + answer + ': ';
      const labels = {correct: 'Correct.', wrong: 'Not quite yet. Check your final answer against your working.', partial: 'Partially correct. Complete your answer or use the requested form.', cannot_judge: 'Not checked automatically. Compare with the reference solution.'};
      this.n.answerFeedback.textContent = label + labels[category];
      this.n.answerFeedback.className = 'answer-feedback' + (category === 'correct' ? ' correct' : ' verdict-' + category);
    }
    showVerdict(category, clarification, answerCategory, formFeedback) {
      this.showSubmissionMark(category, answerCategory);
      const n = this.n, labels = {correct: 'Correct.', wrong: answerCategory === 'correct' ? 'Your answer is correct. Check that each step in your explanation works.' : 'A step needs another look. Check each step against the information in the problem.', partial: 'Partially correct. Explain the missing step so your idea can be checked.', cannot_judge: this.services().inference ? 'Your explanation needs a closer review. Checking it now.' : 'The decision model could not judge this explanation. Add an inference model for a closer review.'};
      n.reasoningFeedback.textContent = 'Thinking: ' + labels[category]; n.reasoningFeedback.className = 'reasoning-feedback verdict-' + category;
      const needsClarification = category === 'partial' || answerCategory === 'partial' || (answerCategory === 'cannot_judge' && clarification);
      n.clarification.hidden = !needsClarification;
      n.clarification.textContent = needsClarification ? (answerCategory === 'partial' && formFeedback) || clarification || (answerCategory === 'partial' ? 'Complete or clarify your answer above, then submit again.' : 'What justifies your next step? Add the missing explanation above, then submit again.') : '';
      if (needsClarification) this.o.typeset(n.clarification);
      this.o.announce.textContent = n.answerFeedback.textContent + ' ' + n.reasoningFeedback.textContent;
    }
    async requestTutor(category, answerCategory, serial) {
      if (this.tutorRequest || !this.services().inference || location.protocol === 'file:' || this.submitted.question.gradingStatus === 'disputed') return;
      const submitted = this.submitted, controller = new AbortController(), n = this.n;
      this.tutorRequest = controller; n.tutorRetry.hidden = true; n.tutorStatus.hidden = false;
      const reviewing = [category, answerCategory].some(value => value === 'partial' || value === 'cannot_judge');
      n.tutorStatus.textContent = reviewing ? 'Taking a closer look at your answer and thinking...' : 'Preparing an optional hint. You can keep working.';
      try {
        const value = await this.post('/api/tutor', {questionId: submitted.question.id, answer: submitted.answer, thoughts: submitted.thoughts, category, answerCategory}, controller);
        if (serial !== this.serial) return;
        this.updateServices(value);
        if (value.configured === false || value.inferenceConfigured === false) {
          this.serviceOverrides.inference = false; n.tutorStatus.hidden = true; n.tutorRetry.hidden = true;
          if (!this.services().decision) this.showUnchecked('Add an inference model in Connections for reasoning feedback.', answerCategory);
          else if (category === 'cannot_judge') this.showVerdict(category, '', answerCategory);
          return;
        }
        if (value.questionId === submitted.question.id && value.answer === submitted.answer && value.gradingStatus === 'disputed' && value.answerCategory === 'not_graded' && value.answerCorrect === null) { this.showNotGraded(value.gradingNote); return; }
        this.reconcileForm(value);
        const needsHint = [value.category, value.answerCategory].some(result => result === 'wrong' || result === 'partial');
        const needsClarification = value.category === 'partial' || ['partial', 'cannot_judge'].includes(value.answerCategory);
        if (value.questionId !== submitted.question.id || value.answer !== submitted.answer || !['correct', 'wrong', 'partial'].includes(value.category) || typeof value.hint !== 'string' || typeof value.clarification !== 'string' || (value.hint + ' ' + value.clarification).trim().split(/\s+/).filter(Boolean).length > 50
          || !this.validAnswer(value) || Boolean(value.hint.trim()) !== needsHint || Boolean(value.clarification.trim()) !== needsClarification) throw new Error('The tutor returned an incomplete or overlong review. Retry the review.');
        this.showAnswer(submitted.answer, value.answerCorrect, value.answerCategory);
        this.showVerdict(value.category, value.clarification, value.answerCategory, value.answerFormFeedback); this.hint = value.hint;
        n.hintToggle.hidden = !this.hint; n.tutorStatus.textContent = this.hint ? 'Your hint is ready when you want it.' : 'Your review is ready.';
        this.o.connection('inference', 'ok', 'Ready', 'The inference model returned a mathematical review.'); this.revisionChanged();
      } catch (error) {
        if (serial !== this.serial) return;
        if (category === 'cannot_judge') n.reasoningFeedback.textContent = 'Thinking: Your explanation still needs a closer review. Retry when ready.';
        n.tutorStatus.textContent = error.name === 'AbortError' ? 'The tutor took too long. Retry when ready.' : error instanceof TypeError ? 'The tutor could not connect. Check inference settings and retry.' : error.message;
        n.tutorRetry.hidden = false; n.tutorRetry.textContent = reviewing ? 'Retry review' : 'Retry hint'; this.revisionChanged();
      } finally { if (serial === this.serial) this.tutorRequest = null; }
    }
  }
  window.MathPracticeFeedback = PracticeFeedback;
})();
