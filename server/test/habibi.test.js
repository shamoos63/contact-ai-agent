import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askedForText, pickHabibiStyle, prepareHabibiText } from '../src/ai/habibi.js';

test('habibi style follows the recorded lines', () => {
  assert.equal(pickHabibiStyle('مرحبا، أهلين فيك! أنا المساعد الذكي تبع توب تك، كيف فيني ساعدك اليوم؟'), 'greeting');
  assert.equal(pickHabibiStyle('تصليح شاشة الآيفون خمسطعش بيكلّف مية وعشرين دولار.'), 'calm');
  assert.equal(pickHabibiStyle('رقم الواتساب تبعنا هو 0944111222'), 'numbers');
  assert.equal(pickHabibiStyle('نحنا فاتحين من السبت للخميس، من الساعة عشرة الصبح لتسعة المسا.'), 'hours');
  assert.equal(pickHabibiStyle('بتحب نحجزلك موعد بكرا الصبح، ولا بيناسبك أكتر بعد الضهر؟'), 'question');
  assert.equal(pickHabibiStyle('معلش، تأخرنا عليك شوي.'), 'apology');
  assert.equal(pickHabibiStyle('عنا لابتوبات مستعملة من نوع Dell وHP.'), 'mixed');
  assert.equal(pickHabibiStyle('تمام يا هشام، ضبطتلك تذكير بكرا الساعة عشرة.'), 'jarvis');
  assert.equal(pickHabibiStyle('أخبار حلوة! طلبك جاهز.'), 'happy');
  assert.equal(pickHabibiStyle('شكراً لتواصلكم معنا. سيقوم أحد المختصين بالرد على استفساركم.'), 'formal');
  assert.equal(pickHabibiStyle('تمام! رح حولك لحدا يتواصل معك.'), 'forward');
  assert.equal(pickHabibiStyle('هههه'), 'laugh');
  assert.equal(pickHabibiStyle('في مواصفات معينة ببالك؟ وشو الاستخدام يلي عندك؟'), 'details');
  assert.equal(pickHabibiStyle('بعتذر منك أوقات الدوام حالياً خلصت.'), 'closed');
});

test('text is sent with a voice note only when someone asks', () => {
  assert.equal(askedForText('كم سعر الشاشة؟'), false);
  assert.equal(askedForText('اكتبها كمان'), true);
  assert.equal(askedForText('please write it down'), true);
});

test('habibi reads digits as Levantine words', () => {
  assert.equal(prepareHabibiText('رقمنا 0944؟'), 'رقمنا صفر تسعة أربعة أربعة ?');
});
