import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFrame, normalizePath, extractEndpoint, extractErrorType,
  extractSignature, buildClusters, renderClusterSummary,
} from '../../scripts/defect-cluster.mjs';

const STACK = `Error: Request failed with status code 500
    at OrderService.getById (/srv/app/order/service.js:42:17)
    at Router.handle (/srv/app/router.js:10:5)`;

function defect(id, overrides = {}) {
  return {
    defect_id: id, fingerprint: id.toLowerCase(), severity: 'P1', category: 'product_defect',
    title: '订单详情接口 500', related_cases: [id], actual_result: 'HTTP 500', analysis: '', ...overrides,
  };
}

test('栈帧归一化去行列号：行号会随构建飘，带行号必然把同一个 bug 拆成两组', () => {
  assert.equal(normalizeFrame('    at OrderService.getById (/srv/app/order/service.js:42:17)'), 'OrderService.getById (/srv/app/order/service.js)');
  assert.equal(
    normalizeFrame('    at OrderService.getById (/srv/app/order/service.js:99:3)'),
    normalizeFrame('    at OrderService.getById (/srv/app/order/service.js:42:17)'),
  );
  assert.equal(normalizeFrame(''), null);
});

test('接口路径归一化：40 条用例各查不同订单，不能因此分出 40 组', () => {
  assert.equal(normalizePath('/orders/123'), '/orders/:id');
  assert.equal(normalizePath('/orders/123/items/456?x=1'), '/orders/:id/items/:id');
  assert.equal(normalizePath('/orders/9f8e7d6c-1111-2222-3333-444455556666'), '/orders/:id');
  assert.equal(normalizePath('/orders'), '/orders');
  assert.equal(normalizePath('not-a-path'), null);
  // 版本号不是动态段：/v2/ 与 /v1/ 是不同路由
  assert.equal(normalizePath('/v2/orders/123'), '/v2/orders/:id');
});

test('从文本里捞方法与路径；捞不到就返回 null，不猜', () => {
  assert.deepEqual(extractEndpoint('POST /api/orders/123 failed'), { method: 'POST', path: '/api/orders/:id' });
  assert.deepEqual(extractEndpoint('url: "/api/orders"'), { method: null, path: '/api/orders' });
  assert.equal(extractEndpoint('something went wrong'), null);
  assert.equal(extractEndpoint(null), null);
});

test('错误类型归一化覆盖命名错误/HTTP 码/超时/连接拒绝', () => {
  assert.equal(extractErrorType('TypeError: x is not a function'), 'TypeError');
  assert.equal(extractErrorType('Request failed with status code 502'), 'HTTP502');
  assert.equal(extractErrorType('read ECONNRESET timeout'), 'Timeout');
  assert.equal(extractErrorType('connect ECONNREFUSED 127.0.0.1:3000'), 'ConnectionRefused');
  assert.equal(extractErrorType('expected 3 to equal 4'), 'AssertionFailed');
  assert.equal(extractErrorType('一切正常'), null);
});

test('40 条同类失败聚成一组，且缺陷单数一分不动', () => {
  const records = Array.from({ length: 40 }, (_, i) => defect(`DEF-${String(i).padStart(3, '0')}`, {
    related_cases: [`TC-${i}`], actual_result: `GET /api/orders/${1000 + i} 返回 HTTP 500`, analysis: STACK,
  }));
  const result = buildClusters(records);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].size, 40);
  assert.equal(result.stats.tickets_before, 40);
  assert.equal(result.stats.groups_after, 1);
  assert.equal(result.stats.clustered_defects, 40);
  // 单数不变：records 原样保留，聚类只给分组
  assert.equal(records.length, 40);
  assert.equal(result.merge_safety, 'display_only');
  assert.match(result.clusters[0].summary, /40 张单同源/);
});

test('同报 500 但根因不同（栈帧/路径不同）不会被合掉', () => {
  const records = [
    defect('DEF-A', { actual_result: `POST /api/orders 500`, analysis: 'at A.fn (/srv/a.js:1:1)' }),
    defect('DEF-B', { actual_result: `POST /api/orders 500`, analysis: 'at B.fn (/srv/b.js:1:1)' }),
    defect('DEF-C', { actual_result: `POST /api/pay 500`, analysis: 'at A.fn (/srv/a.js:1:1)' }),
  ];
  const result = buildClusters(records);
  assert.equal(result.clusters.length, 0, '三个维度各不相同就不该成组');
  assert.equal(result.stats.groups_after, 0);
});

test('没有堆栈也没有接口路径：不参与聚类，并说清是「判不了」不是「没关系」', () => {
  const records = [
    defect('DEF-A', { actual_result: '页面显示异常', analysis: '' }),
    defect('DEF-B', { actual_result: '页面显示异常', analysis: '' }),
  ];
  const result = buildClusters(records);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.unclustered_defect_ids.length, 2);
  assert.match(result.warnings.join(''), /判不了/);
});

test('只有错误类型、没有栈帧与路径时不成组：半截签名会聚出假根因', () => {
  const records = [
    defect('DEF-A', { actual_result: 'Timeout after 30000ms' }),
    defect('DEF-B', { actual_result: 'Timeout after 30000ms' }),
  ];
  assert.equal(buildClusters(records).clusters.length, 0);
});

test('结果数据里的堆栈可以补全记录（缺陷正文常常没带 error 对象）', () => {
  const records = [defect('DEF-A', { related_cases: ['TC-1'], actual_result: '' }), defect('DEF-B', { related_cases: ['TC-2'], actual_result: '' })];
  const results = [
    { case_id: 'TC-1', status: 'failed', error: { type: 'Error', message: 'boom', stack: STACK } },
    { case_id: 'TC-2', status: 'failed', error: { type: 'Error', message: 'boom', stack: STACK } },
  ];
  const result = buildClusters(records, { results });
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].related_cases.length, 2);
});

test('组内代表取最严重的一条，避免拿 P3 当门面', () => {
  const records = [
    defect('DEF-P3', { severity: 'P3', actual_result: 'GET /api/orders/1 500', analysis: STACK }),
    defect('DEF-P0', { severity: 'P0', actual_result: 'GET /api/orders/2 500', analysis: STACK }),
  ];
  const cluster = buildClusters(records).clusters[0];
  assert.equal(cluster.representative, 'DEF-P0');
  assert.equal(cluster.severity, 'P0');
});

test('单条缺陷不构成聚类组', () => {
  const result = buildClusters([defect('DEF-A', { actual_result: 'GET /api/orders/1 500', analysis: STACK })]);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.warnings.length, 0);
});

test('无缺陷时摘要说「无缺陷记录」，不说「0 个根因」', () => {
  const empty = buildClusters([]);
  assert.equal(renderClusterSummary(empty), '本轮无缺陷记录。');
  assert.match(renderClusterSummary(buildClusters([defect('DEF-A', { actual_result: '页面异常' })])), /未形成同源分组/);
});
