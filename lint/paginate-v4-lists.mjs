const LIBRARY = '@shortcut/client/v4';
const PAGED_OPERATION = /^(search|list)[A-Z]/;

const calledMethod = (node) => (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier' ? node.callee.property.name : null);

// A paged call returns a request that `client.paginate(...)` follows page by
// page. Awaiting it, or reading from it, takes the first page and stops. A
// call that is handed on, to `paginate` or to a helper that paginates, is not
// judged here.
const readsOnePage = (node) => node.parent.type === 'AwaitExpression' || (node.parent.type === 'MemberExpression' && node.parent.object === node);

export const paginateV4Lists = {
  meta: {
    type: 'problem',
    messages: {
      onePage: '`{{method}}` returns one page (10 entities unless `limit` says otherwise, at most 100). Pass the call to `client.paginate(...)` so every page is read. An incomplete list must never mean "not there".',
    },
    schema: [],
  },
  create(context) {
    let importsLibrary = false;
    return {
      ImportDeclaration(node) {
        if (node.source.value === LIBRARY) importsLibrary = true;
      },
      CallExpression(node) {
        const method = calledMethod(node);
        if (!importsLibrary || method === null || !PAGED_OPERATION.test(method)) return;
        if (readsOnePage(node)) context.report({ node, messageId: 'onePage', data: { method } });
      },
    };
  },
};
