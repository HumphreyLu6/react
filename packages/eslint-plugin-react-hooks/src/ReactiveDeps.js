/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/* eslint-disable no-for-of-loops/no-for-of-loops */

'use strict';

/**
 * Is this node a reactive React Hook? This includes:
 *
 * - `useEffect()`
 * - `useCallback()`
 * - `useMemo()`
 *
 * TODO: implement autofix.
 *
 * Also supports `React` namespacing. e.g. `React.useEffect()`.
 *
 * NOTE: This is a very naive check. We don't look to make sure these reactive
 * hooks are imported correctly.
 */
function isReactiveHook(node, options) {
  if (
    node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' &&
    node.object.name === 'React' &&
    node.property.type === 'Identifier' &&
    !node.computed
  ) {
    return isReactiveHook(node.property);
  } else if (
    node.type === 'Identifier' &&
    (node.name === 'useEffect' ||
      node.name === 'useLayoutEffect' ||
      node.name === 'useCallback' ||
      node.name === 'useMemo')
  ) {
    return true;
  } else if (options && options.additionalHooks) {
    // Allow the user to provide a regular expression which enables the lint to
    // target custom reactive hooks.
    let name;
    try {
      name = getAdditionalHookName(node);
    } catch (error) {
      if (/Unsupported node type/.test(error.message)) {
        return false;
      } else {
        throw error;
      }
    }
    return options.additionalHooks.test(name);
  } else {
    return false;
  }
}

/**
 * Create a name we will test against our `additionalHooks` regular expression.
 */
function getAdditionalHookName(node) {
  if (node.type === 'Identifier') {
    return node.name;
  } else if (node.type === 'MemberExpression' && !node.computed) {
    const object = getAdditionalHookName(node.object);
    const property = getAdditionalHookName(node.property);
    return `${object}.${property}`;
  } else {
    throw new Error(`Unsupported node type: ${node.type}`);
  }
}

/**
 * Is this node the callback for a reactive hook? It is if the parent is a call
 * expression with a reactive hook callee and this node is a function expression
 * and the first argument.
 */
function isReactiveHookCallback(node, options) {
  return (
    (node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression') &&
    node.parent.type === 'CallExpression' &&
    isReactiveHook(node.parent.callee, options) &&
    node.parent.arguments[0] === node
  );
}

export default {
  meta: {
    fixable: 'code',
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          additionalHooks: {
            type: 'string',
          },
        },
      },
    ],
  },
  create(context) {
    const sourceCode = context.getSourceCode();
    // Parse the `additionalHooks` regex.
    const additionalHooks =
      context.options &&
      context.options[0] &&
      context.options[0].additionalHooks
        ? new RegExp(context.options[0].additionalHooks)
        : undefined;
    const options = {additionalHooks};

    console.log('\n\n\n\n\n\n\n\n\n\n\n\n\n');

    return {
      FunctionExpression: visitFunctionExpression,
      ArrowFunctionExpression: visitFunctionExpression,
    };

    /**
     * Visitor for both function expressions and arrow function expressions.
     */
    function visitFunctionExpression(node) {
      // We only want to lint nodes which are reactive hook callbacks.
      if (!isReactiveHookCallback(node, options)) {
        return;
      }

      // Get the reactive hook node.
      const reactiveHook = node.parent.callee;

      // Get the declared dependencies for this reactive hook. If there is no
      // second argument then the reactive callback will re-run on every render.
      // So no need to check for dependency inclusion.
      const declaredDependenciesNode = node.parent.arguments[1];
      if (!declaredDependenciesNode) {
        return;
      }

      // Get the current scope.
      const scope = context.getScope();

      // Find all our "pure scopes". On every re-render of a component these
      // pure scopes may have changes to the variables declared within. So all
      // variables used in our reactive hook callback but declared in a pure
      // scope need to be listed as dependencies of our reactive hook callback.
      //
      // According to the rules of React you can't read a mutable value in pure
      // scope. We can't enforce this in a lint so we trust that all variables
      // declared outside of pure scope are indeed frozen.
      const pureScopes = new Set();
      {
        let currentScope = scope.upper;
        while (currentScope) {
          pureScopes.add(currentScope);
          if (currentScope.type === 'function') {
            break;
          }
          currentScope = currentScope.upper;
        }
        // If there is no parent function scope then there are no pure scopes.
        // The ones we've collected so far are incorrect. So don't continue with
        // the lint.
        if (!currentScope) {
          return;
        }
      }

      // Get dependencies from all our resolved references in pure scopes.
      const dependencies = new Map();
      gatherDependenciesRecursively(scope);

      function gatherDependenciesRecursively(currentScope) {
        for (const reference of currentScope.references) {
          // If this reference is not resolved or it is not declared in a pure
          // scope then we don't care about this reference.
          if (!reference.resolved) {
            continue;
          }
          if (!pureScopes.has(reference.resolved.scope)) {
            continue;
          }
          // Narrow the scope of a dependency if it is, say, a member expression.
          // Then normalize the narrowed dependency.

          const referenceNode = fastFindReferenceWithParent(
            node,
            reference.identifier,
          );
          const dependencyNode = getDependency(referenceNode);
          const dependency = normalizeDependencyNode(dependencyNode);
          // Add the dependency to a map so we can make sure it is referenced
          // again in our dependencies array.
          let nodes = dependencies.get(dependency);
          if (!nodes) {
            dependencies.set(dependency, (nodes = []));
          }
          nodes.push(dependencyNode);
        }
        for (const childScope of currentScope.childScopes) {
          gatherDependenciesRecursively(childScope);
        }
      }

      const declaredDependencies = [];
      if (declaredDependenciesNode.type !== 'ArrayExpression') {
        // If the declared dependencies are not an array expression then we
        // can't verify that the user provided the correct dependencies. Tell
        // the user this in an error.
        context.report({
          node: declaredDependenciesNode,
          message:
            `React Hook ${context.getSource(reactiveHook)} has a second ` +
            "argument which is not an array literal. This means we can't " +
            "statically verify whether you've passed the correct dependencies.",
        });
      } else {
        declaredDependenciesNode.elements.forEach(declaredDependencyNode => {
          // Skip elided elements.
          if (declaredDependencyNode === null) {
            return;
          }
          // If we see a spread element then add a special warning.
          if (declaredDependencyNode.type === 'SpreadElement') {
            context.report({
              node: declaredDependencyNode,
              message:
                `React Hook ${context.getSource(reactiveHook)} has a spread ` +
                "element in its dependency list. This means we can't " +
                "statically verify whether you've passed the " +
                'correct dependencies.',
            });
            return;
          }
          // Try to normalize the declared dependency. If we can't then an error
          // will be thrown. We will catch that error and report an error.
          let declaredDependency;
          try {
            declaredDependency = normalizeDependencyNode(
              declaredDependencyNode,
            );
          } catch (error) {
            if (/Unexpected node type/.test(error.message)) {
              context.report({
                node: declaredDependencyNode,
                message:
                  'Unsupported expression in React Hook ' +
                  `${context.getSource(reactiveHook)}'s dependency list. ` +
                  'Currently only simple variables are supported.',
              });
              return;
            } else {
              throw error;
            }
          }
          // Add the dependency to our declared dependency map.
          declaredDependencies.push({
            key: declaredDependency,
            node: declaredDependencyNode,
          });
        });
      }

      let suggestedDependencies = [];

      let duplicateDependencies = new Set();
      let unnecessaryDependencies = new Set();
      let missingDependencies = new Set();

      // First, ensure what user specified makes sense.
      for (let {node, key} of declaredDependencies) {
        if (dependencies.has(key)) {
          // Legit dependency.
          if (suggestedDependencies.indexOf(key) === -1) {
            suggestedDependencies.push(key);
          } else {
            // Duplicate. Do nothing.
            duplicateDependencies.add(key);
          }
        } else {
          // Unnecessary dependency. Do nothing.
          unnecessaryDependencies.add(key);
        }
      }
      // Then fill in the missing ones.
      for (let [key, usageNode] of dependencies) {
        if (suggestedDependencies.indexOf(key) === -1) {
          // Legit missing.
          suggestedDependencies.push(key);
          missingDependencies.add(key);
        } else {
          // Already did that. Do nothing.
        }
      }

      if (
        duplicateDependencies.size > 0 ||
        missingDependencies.size > 0 ||
        unnecessaryDependencies.size > 0
      ) {
        context.report({
          node: declaredDependenciesNode,
          message:
            `React Hook ${context.getSource(reactiveHook)} has ` +
            [
              (missingDependencies.size > 0 ?
                `missing [${Array.from(missingDependencies).join(', ')}]`
                : null
              ),
              (duplicateDependencies.size > 0 ?
                `duplicate [${Array.from(duplicateDependencies).join(', ')}]`
                : null
              ),
              (unnecessaryDependencies.size > 0 ?
                `duplicate [${Array.from(unnecessaryDependencies).join(', ')}]` :
                null
              ),
            ].filter(Boolean).join(', ') +
            ` dependencies. Either fix or remove the dependency array.`,
          fix(fixer) {
            return fixer.replaceText(
              declaredDependenciesNode,
              `[${suggestedDependencies.join(', ')}]`
            );
          }
        });
      }
    }
  },
};

/**
 * Gets a dependency for our reactive callback from an identifier. If the
 * identifier is the object part of a member expression then we use the entire
 * member expression as a dependency.
 *
 * For instance, if we get `props` in `props.foo` then our dependency should be
 * the full member expression.
 */
function getDependency(node) {
  if (
    node.parent.type === 'MemberExpression' &&
    node.parent.object === node &&
    !node.parent.computed
  ) {
    return node.parent;
  } else {
    return node;
  }
}

/**
 * Normalizes a dependency into a standard string representation which can
 * easily be compared.
 *
 * Throws an error if the node type is not a valid dependency.
 */
function normalizeDependencyNode(node) {
  if (node.type === 'Identifier') {
    return node.name;
  } else if (node.type === 'MemberExpression' && !node.computed) {
    const object = normalizeDependencyNode(node.object);
    const property = normalizeDependencyNode(node.property);
    return `${object}.${property}`;
  } else {
    throw new Error(`Unexpected node type: ${node.type}`);
  }
}

/**
 * ESLint won't assign node.parent to references from context.getScope()
 *
 * So instead we search for the node from an ancestor assigning node.parent
 * as we go. This mutates the AST.
 *
 * This traversal is:
 * - optimized by only searching nodes with a range surrounding our target node
 * - agnostic to AST node types, it looks for `{ type: string, ... }`
 */
function fastFindReferenceWithParent(start, target) {
  let queue = [start];
  let item = null;

  while (queue.length) {
    item = queue.shift();

    if (isSameIdentifier(item, target)) {
      return item;
    }

    if (!isAncestorNodeOf(item, target)) {
      continue;
    }

    for (let [key, value] of Object.entries(item)) {
      if (key === 'parent') {
        continue;
      }
      if (isNodeLike(value)) {
        value.parent = item;
        queue.push(value);
      } else if (Array.isArray(value)) {
        value.forEach(val => {
          if (isNodeLike(val)) {
            val.parent = item;
            queue.push(val);
          }
        });
      }
    }
  }

  return null;
}

function isNodeLike(val) {
  return (
    typeof val === 'object' &&
    val !== null &&
    !Array.isArray(val) &&
    typeof val.type === 'string'
  );
}

function isSameIdentifier(a, b) {
  return (
    a.type === 'Identifier' &&
    a.name === b.name &&
    a.range[0] === b.range[0] &&
    a.range[1] === b.range[1]
  );
}

function isAncestorNodeOf(a, b) {
  return a.range[0] <= b.range[0] && a.range[1] >= b.range[1];
}
