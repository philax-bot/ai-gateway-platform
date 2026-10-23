'use strict';
// Isolated UI demonstrations only: no network, credentials or persistent business data.
const $ = id => document.getElementById(id);
const money = cents => '¥ ' + (cents / 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const palette = [['--bg','页面底色'],['--surface','内容表面'],['--surface2','层级表面'],['--line','边框'],['--text','正文'],['--action','主要行动'],['--run','运行 / 关联'],['--warn','风险提醒'],['--danger','错误 / 危险'],['--muted','辅助文字'],['--surface3','强调表面'],['--blue','补充信息']];
const style = getComputedStyle(document.documentElement);
$('swatches').innerHTML = palette.map(([token,label]) => `<div class="kit-swatch"><div class="kit-swatch-color" style="background:var(${token})"></div><b>${label}</b><code>${token}</code><small>${style.getPropertyValue(token).trim()}</small></div>`).join('');

$('save-demo').addEventListener('click', async () => {
  const button = $('save-demo');
  button.disabled = true; button.setAttribute('aria-busy','true'); button.textContent = '保存中…';
  $('save-feedback').hidden = true;
  await new Promise(resolve => setTimeout(resolve,700));
  button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = '保存演示';
  $('save-feedback').textContent = '演示保存完成。可继续检查其他组件；未写入业务数据。'; $('save-feedback').hidden = false;
});
$('amount-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('demo-amount'), value = input.value.trim();
  const cents = Math.round(Number(value) * 100);
  const error = !value ? '请填写分配金额。' : !/^\d+(\.\d{1,2})?$/.test(value) ? '请输入正数金额，最多两位小数。' : cents <= 0 ? '金额必须大于 0。' : !Number.isSafeInteger(cents) || cents > 80000 ? '金额超过该来源批次待分配的 ¥ 800.00，请减少金额。' : '';
  input.setAttribute('aria-invalid', String(Boolean(error)));
  $('amount-error').textContent = error; $('amount-error').hidden = !error;
  $('amount-success').hidden = Boolean(error);
  if (error) input.focus();
  else $('amount-success').textContent = `金额校验通过：${money(cents)}。正式流程接着预览来源、成员、有效期和影响；此处不发放额度。`;
});
const states = {
  ready: ['可使用','当前模型有有效授权和匹配额度。','下一步：在线使用 / 编程接入','run'],
  empty: ['尚未开通','当前没有有效个人权益，不代表平台没有可用模型。','下一步：申请开通模型与额度','warn'],
  loading: ['正在读取额度…','保留当前用途，金额暂不显示为 0。','完成后展示该用途的有效余额','run'],
  connection: ['额度读取失败','暂时无法确认余额，不沿用未知金额执行操作。','下一步：重试读取；再次失败时联系运营','error'],
  denied: ['无分配权限','当前角色可以查看已获额度，不能分配项目总额度。','下一步：向项目经理申请成员额度','warn'],
  pending: ['追加申请待审批 · 已有额度仍可使用','申请交运营处理；当前已有授权和余额保持可用。','下一步：继续使用，或查看申请进度','warn'],
  unavailable: ['模型暂不可用','当前模型来源已停用，授权、余额和输入仍然保留。','下一步：查看模型范围与运营处理说明','error'],
  noquota: ['无有效额度','模型已开放，但没有有效且适用于该模型的批次。','下一步：申请对应来源额度','warn'],
  insufficient: ['额度不足','有效批次存在，但余额不足以支持当前调用。','下一步：追加对应来源额度','warn'],
  failure: ['保存失败','变更尚未生效，保留输入和原配置。','下一步：核对原因后重试','error'],
  success: ['开通成功 · 演示','示例权益与首次额度已就绪。','下一步：返回原用途，开始使用','run'],
  unknown: ['费用待核对','缺少可确认的费用数据，不显示为 ¥ 0.00。','下一步：查看对应调用记录与核对进度','warn']
};
function renderState() {
  const key = $('state-picker').value, [title,description,next,tone] = states[key];
  $('state-preview').dataset.tone = tone;
  $('state-preview').setAttribute('aria-busy',String(key === 'loading'));
  $('state-preview').innerHTML = `<b>${title}</b><p>${description}</p><span class="kit-state-next">${next}</span>`;
}
$('state-picker').addEventListener('change',renderState); renderState();

const poolData = {office: {name:'办公通用池',models:['Qwen 2.5','DeepSeek V3']},research: {name:'研发模型池',models:['DeepSeek V3','Qwen 2.5']}};
const selections = {office:new Set(['Qwen 2.5']),research:new Set(['DeepSeek V3'])};
const expanded = new Set();
function renderAccess() {
  const poolId = $('access-pool').value, pool = poolData[poolId];
  const follow = document.querySelector('[name=access-mode]:checked').value === 'follow';
  const models = [...pool.models, ...(expanded.has(poolId) ? ['GLM 演示模型'] : [])];
  $('model-choices').hidden = follow;
  $('model-choices').innerHTML = '<legend>选择授权模型</legend>' + models.map((name,i) => `<label><input type="checkbox" data-model-index="${i}" ${selections[poolId].has(name)?'checked':''}>${name}</label>`).join('') + '<label><input type="checkbox" disabled aria-describedby="staged-model">文档模型</label><small id="staged-model">未开放，暂不可选</small>';
  const granted = follow ? models : models.filter(name => selections[poolId].has(name));
  $('access-summary').innerHTML = `<small>${pool.name} · ${follow?'跟随模型池':'仅指定模型'}</small><b>${granted.length ? granted.join(' / ') : '尚未选择模型，不能保存'}</b><p>${follow?'今后池内新增开放模型会自动纳入范围。':'仅包含勾选的模型，池内新增模型不会自动纳入。'}</p><small>池内关闭模型或来源停用，都会阻止对应新调用。</small>`;
  $('pool-new-model').disabled = expanded.has(poolId);
  $('pool-new-model').textContent = expanded.has(poolId) ? '已新增 GLM 演示模型' : '模拟：池内新增开放模型';
}
$('access-pool').addEventListener('change',renderAccess);
document.querySelectorAll('[name=access-mode]').forEach(input => input.addEventListener('change',renderAccess));
$('model-choices').addEventListener('change',event => {
  const index = event.target.dataset.modelIndex; if (index === undefined) return;
  const poolId = $('access-pool').value, models = [...poolData[poolId].models,...(expanded.has(poolId)?['GLM 演示模型']:[])];
  if (event.target.checked) selections[poolId].add(models[Number(index)]); else selections[poolId].delete(models[Number(index)]);
  // Keep the active checkbox in place for keyboard users.
  const activeIndex = index; renderAccess(); $('model-choices').querySelector(`[data-model-index="${activeIndex}"]`).focus();
});
$('pool-new-model').addEventListener('click',() => {expanded.add($('access-pool').value); renderAccess();}); renderAccess();

const batches = {
  personal:[{name:'办公方案 · 十月批次',amount:20000,spent:8000,expiry:'2026-10-31',models:['Qwen 2.5','DeepSeek V3']},{name:'写作方案 · 专项批次',amount:10000,spent:4000,expiry:'2026-12-31',models:['Qwen 2.5']}],
  project:[{name:'Q4 项目 · 成员分配批次',amount:50000,spent:10000,expiry:'2026-12-31',models:['Qwen 2.5','DeepSeek V3']}]
};
function renderQuota() {
  const purpose = $('quota-purpose').value, model = $('quota-model').value, rows = batches[purpose];
  const total = rows.reduce((sum,b) => sum+b.amount-b.spent,0), applicable = rows.filter(b => b.models.includes(model)).reduce((sum,b) => sum+b.amount-b.spent,0);
  $('quota-summary').innerHTML = `<div class="balance-card"><small>当前用途总余额</small><strong>${money(total)}</strong><div class="secondary">${purpose==='personal'?'仅个人有效批次':'仅当前项目的成员余额'}</div></div><div class="balance-card model-funds"><small>当前模型适用余额 · ${model}</small><strong>${money(applicable)}</strong><div class="secondary">同时符合模型授权与有效批次</div></div>`;
  const nodes = purpose==='personal' ? [['权限来源','个人开通方案','各方案限定模型范围'],['资金来源','个人额度批次','分别保留金额与有效期'],['使用主体','员工 · 个人用途','仅扣匹配的个人批次']] : [['资金来源','项目总额度批次','总额先进入项目'],['分配来源','项目成员分配','继承总额度批次期限'],['使用主体','员工 · 项目用途','继承项目模型范围']];
  $('quota-path').innerHTML = nodes.map(([label,title,detail]) => `<div class="node"><small>${label}</small><b>${title}</b><em>${detail}</em></div>`).join('<span class="arrow" aria-hidden="true">→</span>');
  $('quota-batches').innerHTML = rows.map(b => `<tr><td>${b.name}<small>${b.models.join(' / ')}</small></td><td>${money(b.amount)}</td><td>${money(b.spent)}</td><td>${money(b.amount-b.spent)}</td><td>${b.expiry}</td><td><span class="tag ${b.models.includes(model)?'':'neutral'}">${b.models.includes(model)?'适用':'不适用'}</span></td></tr>`).join('');
  $('quota-note').textContent = purpose==='personal' ? '切换到 DeepSeek V3：用途总余额仍为 ¥ 180.00，但模型适用余额只有 ¥ 120.00。写作专项余额不能借用。' : '这里展示成员已经获分配的 ¥ 500.00；已用 ¥ 100.00，剩余 ¥ 400.00。项目待分配总额不计入员工余额。';
}
$('quota-purpose').addEventListener('change',renderQuota); $('quota-model').addEventListener('change',renderQuota); renderQuota();

let serviceEnabled = true, dialogTrigger;
const dialog = $('impact-dialog');
function openImpact(event) {
  dialogTrigger = event.currentTarget;
  if (!serviceEnabled) { $('impact-result').hidden = false; $('impact-result').textContent = '示例服务已停用。可在下方重新启用后再次查看预览。'; $('impact-result').scrollIntoView({block:'center'}); return; }
  dialog.returnValue = ''; dialog.showModal();
}
$('open-disable').addEventListener('click',openImpact);
$('service-toggle').addEventListener('click',event => {
  if (serviceEnabled) return openImpact(event);
  serviceEnabled = true; renderService(); $('impact-result').hidden = false; $('impact-result').textContent = '示例服务已重新启用，对应模型恢复可用。';
});
function renderService() {
  $('service-status').textContent = serviceEnabled?'已启用 · 示例':'已停用 · 示例';
  $('service-status').className = serviceEnabled?'tag':'tag warn';
  $('service-toggle').textContent = serviceEnabled?'预览停用影响':'重新启用（演示）';
  $('service-toggle').className = serviceEnabled?'danger-button':'ghost';
}
dialog.addEventListener('close',() => {
  if (dialog.returnValue === 'confirm') {serviceEnabled = false; renderService(); $('impact-result').hidden = false; $('impact-result').textContent = '示例服务已停用。相关新调用被阻止，授权、余额与历史保留。';}
  dialogTrigger?.focus();
});
const sectionObserver = new IntersectionObserver(entries => {
  const entry = entries.find(item => item.isIntersecting); if (!entry) return;
  document.querySelectorAll('.kit-nav a').forEach(a => {if (a.hash === '#'+entry.target.id) a.setAttribute('aria-current','location'); else a.removeAttribute('aria-current');});
},{rootMargin:'-10% 0px -65% 0px',threshold:0});
document.querySelectorAll('.kit-section').forEach(section => sectionObserver.observe(section));
