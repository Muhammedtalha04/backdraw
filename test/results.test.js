'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { FINAL, DEFAULT_WAIT, EDIT_INTENT, waitSeconds, editCheckLines, resultLines } = require('../lib/results');

const CHAT_URL = 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f-images/c/6812a3b4-1c2d-8000-9e8f-0123456789ab';
const job = fields => ({ id: 'img_1a2b3c4d', prompt: 'a void mage', images: [], copies: [], references: [], ...fields });
const check = (...similarities) => ({ results: similarities.map((similarity, i) => ({ similarity, against: `ref${i + 1}.png` })) });
const text = j => resultLines(j).join('\n');

test('final statuses and the default wait', () => {
  assert.deepEqual([...FINAL].sort(), ['cancelled', 'failed', 'needs_reference', 'succeeded', 'text_reply']);
  assert.equal(DEFAULT_WAIT, 45);
});

test('waitSeconds: 45 unless wait_seconds is a number, clamped to 0-900', () => {
  assert.equal(waitSeconds({}), 45);
  assert.equal(waitSeconds({ wait_seconds: null }), 45);
  assert.equal(waitSeconds({ wait_seconds: '' }), 45);
  assert.equal(waitSeconds({ wait_seconds: 'soon' }), 45);
  assert.equal(waitSeconds({ wait_seconds: 5000 }), 900);
  assert.equal(waitSeconds({ wait_seconds: -1 }), 0);
  assert.equal(waitSeconds({ wait_seconds: 0 }), 0);
  assert.equal(waitSeconds({ wait_seconds: '30' }), 30);
  assert.equal(waitSeconds({ wait_seconds: 12.6 }), 13);
});

test('editCheckLines: no check, nothing to say', () => {
  assert.deepEqual(editCheckLines(job({})), []);
  assert.deepEqual(editCheckLines(job({ editCheck: { results: [] } })), []);
});

test('editCheckLines: 75% or more unchanged is a real edit', () => {
  const lines = editCheckLines(job({ prompt: 'edit: close the eyes', editCheck: check(0.75) }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Edit check: 75% of the image is unchanged compared with ref1\.png/);
  assert.match(lines[0], /\(edited: true\)/);
  assert.match(editCheckLines(job({ editCheck: check(0.98) }))[0], /98%.*edited: true/);
});

test('editCheckLines: under 75% with an edit request warns', () => {
  const [line] = editCheckLines(job({ prompt: 'Edit the image: only change the sky', editCheck: check(0.4) }));
  assert.match(line, /EDIT CHECK \(edited: false\)/);
  assert.match(line, /only 40% of the image matches ref1\.png/);
  assert.match(line, /reference_images=\[the original image file\]/);
});

test('editCheckLines: at the 75% boundary the verdict follows the shown percentage', () => {
  assert.match(editCheckLines(job({ prompt: 'keep everything else', editCheck: check(0.7449) }))[0], /EDIT CHECK \(edited: false\): only 74% /);
  assert.match(editCheckLines(job({ prompt: 'keep everything else', editCheck: check(0.74) }))[0], /EDIT CHECK \(edited: false\): only 74% /);
  // The extension rounds to hundredths; anything shown as 75% counts as an edit.
  assert.match(editCheckLines(job({ prompt: 'keep everything else', editCheck: check(0.7499) }))[0], /^Edit check: 75% .*\(edited: true\)/);
});

test('editCheckLines: under 75% without an edit request is a neutral note', () => {
  const [line] = editCheckLines(job({ prompt: 'a castle at night', editCheck: check(0.3) }));
  assert.equal(line, 'Similarity to ref1.png: 30% (a local edit keeps ~95-100%, a redraw is usually under 60%).');
  assert.equal(editCheckLines(job({ prompt: undefined, editCheck: check(0.3) }))[0], line);
});

test('editCheckLines: the least similar output decides', () => {
  const [line] = editCheckLines(job({ prompt: 'edit it', editCheck: check(0.97, 0.5, 0.9) }));
  assert.match(line, /EDIT CHECK \(edited: false\): only 50% of the image matches ref2\.png/);
  assert.match(editCheckLines(job({ editCheck: check(0.9, 0.8) }))[0], /80% .* ref2\.png .*edited: true/);
});

test('edit intent: English and Turkish wording', () => {
  for (const p of ['Edit this', 'modify the colors', 'retouch the face', 'change only the hat', 'keep the rest', 'same pose, new outfit',
    'pixel-identical except the eyes', 'Make these edits: close the eyes', 'editing the photo: remove the hat', 'the edited version',
    'modifying the light', 'it modifies the sky', 'retouched skin', 'inpainting the sky', 'change the background only',
    'Gözleri kapat, gerisini düzenle', 'arka planı değiştir', 'karakter aynı kalsın',
    'yüzü aynı bırak', 'rengi koru', 'yüzü koruyarak yeniden çiz']) {
    assert.ok(EDIT_INTENT.test(p), p);
  }
  for (const p of ['a castle at night', 'credit card', 'korusun', 'a new image of a dragon', 'a video editor at her desk', 'an editorial photo',
    'a credited author', 'a chameleon that can change color']) assert.ok(!EDIT_INTENT.test(p), p);
  const [line] = editCheckLines(job({ prompt: 'sadece gözleri değiştir', editCheck: check(0.2) }));
  assert.match(line, /EDIT CHECK \(edited: false\)/);
});

test('resultLines: succeeded with saved files, copies and a copy error', () => {
  const lines = resultLines(job({
    status: 'succeeded', conversationUrl: CHAT_URL,
    images: [{ path: 'C:\\Pictures\\Backdraw\\a.png', width: 1024, height: 1536 }, { path: 'C:\\Pictures\\Backdraw\\b.png' }],
    copies: ['D:\\game\\assets\\a.png'], copyError: 'EACCES: permission denied',
    references: [{ name: 'ref.png' }], assistantText: 'Here is your image.',
  }));
  assert.deepEqual(lines, [
    'SUCCESS — ChatGPT generated 2 image(s). Job img_1a2b3c4d.',
    `ChatGPT conversation: ${CHAT_URL}`,
    'Reference images attached: ref.png',
    'Saved: C:\\Pictures\\Backdraw\\a.png (1024x1536)',
    'Saved: C:\\Pictures\\Backdraw\\b.png',
    'Copied to: D:\\game\\assets\\a.png',
    'Could not copy into output_dir: EACCES: permission denied',
    "ChatGPT's text: Here is your image.",
  ]);
});

test('resultLines: succeeded after a re-attach notes it', () => {
  assert.match(text(job({ status: 'succeeded', reattached: true, images: [{ path: 'a.png' }] })), /the bridge re-attached it and asked once more/);
  assert.doesNotMatch(text(job({ status: 'failed', reattached: true, error: 'x' })), /re-attached it and asked once more/);
});

test('resultLines: queued shows the queue position and how to keep waiting', () => {
  const t = text(job({ status: 'queued', queuePosition: 2 }));
  assert.match(t, /^QUEUED — position 2 in the queue \(position 1 starts as soon as the running job, if any, is done\)\. Job img_1a2b3c4d\./);
  assert.match(t, /Call job_status with job_id="img_1a2b3c4d" and wait_seconds=45 again \(repeat until it finishes\), or cancel_job to stop it\./);
});

test('resultLines: queued without a known position says so', () => {
  const t = text(job({ status: 'queued' }));
  assert.match(t, /^QUEUED — position \? in the queue/);
  assert.match(t, /job_status with job_id="img_1a2b3c4d"/);
});

test('resultLines: running (and any other unfinished status) says STILL RUNNING', () => {
  assert.equal(resultLines(job({ status: 'running', step: 'generating', message: 'ChatGPT is generating the image' }))[0],
    'STILL RUNNING — ChatGPT is generating the image. Job img_1a2b3c4d. Call job_status with job_id="img_1a2b3c4d" and wait_seconds=45 again (repeat until it finishes), or cancel_job to stop it.');
  const t = text(job({ status: 'running', step: 'uploading', conversationUrl: CHAT_URL }));
  assert.match(t, /^STILL RUNNING — uploading\./);
  assert.match(t, /job_status/);
  assert.match(t, /wait_seconds=45/);
  assert.match(t, new RegExp(`ChatGPT conversation: ${CHAT_URL.replace(/[.?]/g, '\\$&')}`));
  assert.match(text(job({ status: 'starting', step: 'starting' })), /^STILL RUNNING — starting\./);
});

test('resultLines: needs_human asks for the user and how to check again', () => {
  const lines = resultLines(job({ status: 'needs_human', message: 'ChatGPT shows a human-verification page' }));
  assert.equal(lines[0], 'NEEDS USER ACTION — ChatGPT shows a human-verification page (job img_1a2b3c4d)');
  assert.match(lines[1], /open the ChatGPT tab in Chrome and complete it themselves; do not try to bypass it/);
  assert.match(lines[1], /job_status\(job_id="img_1a2b3c4d", wait_seconds=45\)/);
});

test('resultLines: needs_reference lists the images already saved from the chat', () => {
  const lines = resultLines(job({
    status: 'needs_reference', reattached: true, conversationUrl: CHAT_URL,
    chatImages: [{ job: 'img_old1', path: 'C:\\Pictures\\Backdraw\\old.png', prompt: 'the first mage' }],
  }));
  assert.match(lines[0], /^NEEDS REFERENCE IMAGE — .*\(job img_1a2b3c4d\)\. It still asked after the bridge re-attached the image\.$/);
  assert.match(lines[1], /^Do NOT resend the same prompt\. .*auto_reattach=true/);
  assert.deepEqual(lines.slice(-2), [
    'Images already saved from this chat (newest first) — usable as reference_images:',
    '- C:\\Pictures\\Backdraw\\old.png  (img_old1: "the first mage")',
  ]);
  assert.doesNotMatch(resultLines(job({ status: 'needs_reference' }))[0], /re-attached/);
});

test('resultLines: text_reply shows ChatGPT\'s whole reply', () => {
  const reply = `Which aspect ratio would you like?\n${'x'.repeat(4000)}`;
  const lines = resultLines(job({ status: 'text_reply', assistantText: reply, conversationUrl: CHAT_URL }));
  assert.match(lines[0], /^CHATGPT REPLIED WITHOUT AN IMAGE \(job img_1a2b3c4d\)\./);
  assert.match(lines[0], /send_as_is=true/);
  assert.equal(lines[2], `ChatGPT's reply:\n${reply.slice(0, 3000)}`);
});

test('resultLines: failed and cancelled', () => {
  assert.equal(resultLines(job({ status: 'failed', error: 'ChatGPT did not return an image.' }))[0],
    'FAILED — ChatGPT did not return an image. (job img_1a2b3c4d)');
  assert.equal(resultLines(job({ status: 'failed' }))[0], 'FAILED — unknown error (job img_1a2b3c4d)');
  assert.deepEqual(resultLines(job({ status: 'cancelled' })), ['CANCELLED — job img_1a2b3c4d.']);
});

test('resultLines: a succeeded edit includes the edit check', () => {
  const t = text(job({ status: 'succeeded', prompt: 'düzenle: gözleri kapat', images: [{ path: 'a.png' }], editCheck: check(0.3) }));
  assert.match(t, /EDIT CHECK \(edited: false\)/);
});
