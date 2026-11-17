// Helpers for the shared picker in automation-owned browser fixtures.
export async function choosePerson({evaluate,waitFor},label,person){
  const q=JSON.stringify;
  await evaluate(`(()=>{const b=[...document.querySelectorAll('.person-picker-trigger')].find(b=>b.getAttribute('aria-label')===${q(label)});if(!b)throw Error('Missing person field: '+${q(label)});b.focus();b.click();})()`);
  await waitFor(`!!document.querySelector('.person-picker-modal[open]')`);
  await evaluate(`(()=>{const el=document.querySelector('.person-picker-people input:not([type])');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${q(person.directoryId)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor(`[...document.querySelectorAll('.person-picker-results .person-row')].some(r=>r.querySelector('code')?.textContent===${q(person.directoryId)})`);
  await evaluate(`(()=>{const row=[...document.querySelectorAll('.person-picker-results .person-row')].find(r=>r.querySelector('code')?.textContent===${q(person.directoryId)});row.querySelector('input').click();})()`);
  await evaluate(`[...document.querySelectorAll('.person-picker-modal .modal-footer button')].find(b=>b.textContent==='确认选择').click()`);
  await waitFor(`!document.querySelector('.person-picker-modal[open]')`);
}
