import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceDestination } from '../public/shared/voice-flow.js';
import { voiceViews } from '../public/shared/voice-view.js';
import { supportWindowText } from '../lib/insights.mjs';

test('voice destinations keep physician recordings private and never imply automatic patient linkage or form saving', () => {
  const patient=voiceDestination({scope:'patient',sharing:false});
  assert.match(patient.detail,/после вашего согласия/);
  assert.match(voiceDestination({scope:'patient',sharing:true}).detail,/подключённый врач/);
  assert.match(voiceDestination({scope:'vop'}).detail,/автоматически не прикрепляются/);
  assert.match(voiceDestination({scope:'psychiatrist',ownerLabel:'TEST'}).detail,/Пациент её не увидит/);
  const insert=voiceDestination({scope:'patient',insertTarget:{}});
  assert.equal(insert.href,null);assert.match(insert.detail,/отправьте саму форму/);
});
test('voice review keeps untrusted transcript literal and optional analysis in its own window', () => {
  const v={options:{scope:'patient'},stage:'review',rows:[{id:'s0',role:'patient',start:0,end:3,text:'<script>PRIVATE</script> Я не принимаю лекарство.',topics:[]}],title:'<b>Title</b>',page:0,errors:[],pending:0};
  const ui=voiceViews(v,{isDoctor:false,perPage:3,microphonePicker:()=>'',mic:'',voiceWhen:()=>''});
  const review=ui.reviewBody();
  assert.doesNotMatch(review,/<script>|<b>Title/);assert.match(review,/&lt;script&gt;/);assert.match(review,/Я не принимаю/);
  assert.doesNotMatch(review,/voice-analysis-title|Что обсудить|data-v="analyze"/);
  assert.match(ui.analysisBody(),/voice-analysis-title/);
  v.pending=1;assert.match(ui.footer(),/data-v="save"[^>]*disabled/);
});
test('chat opens recommendations separately but retains direct safety guidance', () => {
  const normal=supportWindowText({urgent:false,facts:[{text:'PRIVATE-FACT'}]});
  assert.match(normal,/отдельном окне/);assert.doesNotMatch(normal,/PRIVATE/);
  const urgent=supportWindowText({urgent:true});
  assert.match(urgent,/помощь и оценка безопасности/);assert.match(urgent,/приостановлены/);
  assert.doesNotMatch(urgent,/Откройте окно кнопкой ниже/);
});
