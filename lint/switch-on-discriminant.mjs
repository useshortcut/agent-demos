const isNode = (value) => typeof value === 'object' && value !== null && 'type' in value;

const discriminantAccess = (node) =>
  isNode(node) && node.type === 'MemberExpression' && node.computed !== true && isNode(node.property) && node.property.type === 'Identifier' ? node : null;

const isStringLiteral = (node) => isNode(node) && node.type === 'Literal' && typeof node.value === 'string';

function comparedDiscriminantOwner(test) {
  if (test.type !== 'BinaryExpression') return null;
  if (test.operator !== '===' && test.operator !== '!==') return null;
  if (isStringLiteral(test.right)) return discriminantAccess(test.left);
  if (isStringLiteral(test.left)) return discriminantAccess(test.right);
  return null;
}

const rangeOf = (node) => (Array.isArray(node.range) && typeof node.range[0] === 'number' && typeof node.range[1] === 'number' ? node.range : null);

function chainContainer(branch) {
  let parent = branch.parent;
  while (isNode(parent) && (parent.type === 'IfStatement' || parent.type === 'ConditionalExpression')) parent = parent.parent;
  return isNode(parent) ? parent : null;
}

const EXIT_STATEMENTS = new Set(['ReturnStatement', 'ThrowStatement', 'ContinueStatement', 'BreakStatement']);

function alwaysExits(statement) {
  if (!isNode(statement)) return false;
  if (EXIT_STATEMENTS.has(statement.type)) return true;
  return statement.type === 'BlockStatement' && Array.isArray(statement.body) && alwaysExits(statement.body.at(-1));
}

// A branch dispatches when taking it means the other variants are handled
// elsewhere: a ternary, an if with an else, an else-if, or an if that leaves.
const dispatches = (branch) =>
  branch.type === 'ConditionalExpression' || isNode(branch.alternate) || (isNode(branch.parent) && branch.parent.type === 'IfStatement') || alwaysExits(branch.consequent);

export const switchOnDiscriminant = {
  meta: {
    type: 'problem',
    messages: {
      useSwitch:
        'These branches test `{{owner}}` more than once. Use a switch so switch-exhaustiveness-check catches new variants; an if chain silently routes a new variant into its last branch.',
    },
    schema: [],
  },
  create(context) {
    const testsByChain = new Map();
    const record = (branch) => {
      if (!isNode(branch) || !isNode(branch.test) || !dispatches(branch)) return;
      const access = comparedDiscriminantOwner(branch.test);
      const container = chainContainer(branch);
      const accessRange = access && rangeOf(access);
      const containerRange = container && rangeOf(container);
      const testRange = rangeOf(branch.test);
      if (!accessRange || !containerRange || !testRange) return;
      const owner = context.sourceCode.text.slice(accessRange[0], accessRange[1]);
      const key = `${containerRange[0]}:${owner}`;
      testsByChain.set(key, [...(testsByChain.get(key) ?? []), testRange]);
    };
    return {
      IfStatement: record,
      ConditionalExpression: record,
      'Program:exit': () => {
        for (const [key, tests] of testsByChain) {
          if (tests.length < 2) continue;
          const owner = key.slice(key.indexOf(':') + 1);
          for (const [start, end] of tests) {
            context.report({ loc: { start: context.sourceCode.getLocFromIndex(start), end: context.sourceCode.getLocFromIndex(end) }, messageId: 'useSwitch', data: { owner } });
          }
        }
      },
    };
  },
};
