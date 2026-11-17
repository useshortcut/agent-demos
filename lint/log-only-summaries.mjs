const isNode = (value) => typeof value === 'object' && value !== null && 'type' in value;

const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug']);
const FREE_FORM = new Set(['message', 'stack', 'cause']);

const isConsoleCall = (node) =>
  node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier' && node.callee.object.name === 'console' && LOG_METHODS.has(node.callee.property.name);

const isFunction = (node) => node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';

const isCatchCallback = (node) =>
  isFunction(node) && isNode(node.parent) && node.parent.type === 'CallExpression' && node.parent.arguments[0] === node && node.parent.callee.type === 'MemberExpression' && node.parent.callee.property.name === 'catch';

/** The names bound to a caught value around `node`: `catch (error)` and `.catch((error) => ...)`. */
function caughtNames(node) {
  const names = new Set();
  for (let at = node.parent; isNode(at); at = at.parent) {
    if (at.type === 'CatchClause' && at.param?.type === 'Identifier') names.add(at.param.name);
    if (isCatchCallback(at) && at.params[0]?.type === 'Identifier') names.add(at.params[0].name);
  }
  return names;
}

// What a log line would print of `node`. A call is not entered: what a
// function such as summarizeShortcutV4Error returns is its own to vouch for.
function* printed(node) {
  if (!isNode(node)) return;
  switch (node.type) {
    case 'Identifier':
    case 'MemberExpression':
      yield node;
      return;
    case 'ObjectExpression':
      for (const property of node.properties) yield* printed(property.type === 'SpreadElement' ? property.argument : property.value);
      return;
    case 'ArrayExpression':
      for (const element of node.elements) yield* printed(element?.type === 'SpreadElement' ? element.argument : element);
      return;
    case 'TemplateLiteral':
      for (const expression of node.expressions) yield* printed(expression);
      return;
    case 'ConditionalExpression':
      yield* printed(node.consequent);
      yield* printed(node.alternate);
      return;
    case 'LogicalExpression':
    case 'BinaryExpression':
      yield* printed(node.left);
      yield* printed(node.right);
      return;
    case 'SpreadElement':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
      yield* printed(node.type === 'SpreadElement' ? node.argument : node.expression);
      return;
  }
}

export const logOnlySummaries = {
  meta: {
    type: 'problem',
    messages: {
      whole:
        '`{{name}}` is a caught error, and this logs it whole. A rejected Shortcut request carries a body that can echo request content, and other errors carry free-form text. Log `summarizeShortcutV4Error({{name}})`, or the fields you mean: a status, a name, an identifier-shaped code.',
      freeForm: '`{{text}}` is free-form text from an error and can carry request content or a credential. Log a status, a name, or an identifier-shaped code.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isConsoleCall(node)) return;
        const caught = caughtNames(node);
        for (const argument of node.arguments) {
          for (const value of printed(argument)) {
            if (value.type === 'Identifier' && caught.has(value.name)) context.report({ node: value, messageId: 'whole', data: { name: value.name } });
            if (value.type === 'MemberExpression' && !value.computed && value.object.type === 'Identifier' && caught.has(value.object.name) && FREE_FORM.has(value.property.name)) {
              context.report({ node: value, messageId: 'freeForm', data: { text: `${value.object.name}.${value.property.name}` } });
            }
          }
        }
      },
    };
  },
};
