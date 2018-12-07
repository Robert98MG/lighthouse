/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/* global getComputedStyle, getElementsInDocument, Node, getNodePath, getNodeSelector */

const Gatherer = require('../gatherer');
const pageFunctions = require('../../../lib/page-functions.js');
const {rectContainsString, rectContains} = require('../../../lib/client-rect-functions');

const TARGET_SELECTORS = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'option',
  '[role=button]',
  '[role=checkbox]',
  '[role=link]',
  '[role=menuitem]',
  '[role=menuitemcheckbox]',
  '[role=menuitemradio]',
  '[role=option]',
  '[role=scrollbar]',
  '[role=slider]',
  '[role=spinbutton]',
];

/**
 * @param {LH.Artifacts.ClientRect[]} clientRects
 */
/* istanbul ignore next */
function allClientRectsEmpty(clientRects) {
  return (
    clientRects.length === 0 ||
    clientRects.every(cr => cr.width === 0 && cr.height === 0)
  );
}

function nodeIsVisible(node) {
  const {
    overflowX,
    overflowY,
    display,
    visibility,
  } = getComputedStyle(node);

  if (
    display === 'none' ||
    (visibility === 'collapse' && ['TR', 'TBODY', 'COL', 'COLGROUP'].includes(node.tagName))
  ) {
    // Element not displayed
    return false;
  }

  if (display === 'block' || display === 'inline-block') {
    // if height/width is 0 and no overflow in that direction then
    // there's no content that the user can see and tap on
    if (node.clientWidth === 0 && overflowX === 'hidden') {
      return false;
    }
    if (node.clientHeight === 0 && overflowY === 'hidden') {
      return false;
    }
  }

  const parent = node.parentElement;
  if (
    parent &&
    parent.tagName !== 'HTML' &&
    !nodeIsVisible(parent)
  ) {
    // if a parent is invisible then the current node is also invisible
    return false;
  }

  return true;
}

/**
 * @param {Element} node
 */
function getVisibleClientRects(node) {
  if (!nodeIsVisible(node)) {
    return [];
  }

  const {
    overflowX,
    overflowY,
  } = getComputedStyle(node);
  let clientRects = getClientRects(node, true);

  if (allClientRectsEmpty(clientRects)) {
    if ((overflowX === 'hidden' && overflowY === 'hidden') || node.children.length === 0) {
      // own size is 0x0 and there's no visible child content
      return [];
    }
  }

  // Treating overflowing content in scroll containers as invisible could mean that
  // most of a given page is deemed invisible. But:
  // - tap targets audit doesn't consider different containers/layers
  // - having most content in an explicit scroll container is rare
  // - treating them as hidden only generates false passes, which is better than false failures
  clientRects = filterClientRectsWithinAncestorsVisibleScrollArea(node, clientRects);

  return clientRects;
}


// /**
//  * @param {Element} node
//  * @param {LH.Artifacts.ClientRect[]} clientRects
//  * @returns {boolean}
//  */
// /* istanbul ignore next */
// function isWithinAncestorsVisibleScrollArea(node, clientRects) {
//   const parent = node.parentElement;
//   if (!parent) {
//     return true;
//   }
//   if (getComputedStyle(parent).overflowY !== 'visible') {
//     for (let i = 0; i < clientRects.length; i++) {
//       const clientRect = clientRects[i];
//       if (!rectContains(parent.getBoundingClientRect(), clientRect)) {
//         return false;
//       }
//     }
//   }
//   if (parent.parentElement && parent.parentElement.tagName !== 'HTML') {
//     return isWithinAncestorsVisibleScrollArea(
//       parent.parentElement,
//       clientRects
//     );
//   }
//   return true;
// }

/**
 * @param {string} str
 * @param {number} maxLength
 * @returns {string}
 */
/* istanbul ignore next */
function truncate(str, maxLength) {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 1) + '…';
}

/**
 * @param {Element} node
 * @param {boolean} includeChildren
 * @returns {LH.Artifacts.ClientRect[]}
 */
/* istanbul ignore next */
function getClientRects(node, includeChildren = true) {
  /** @type {LH.Artifacts.ClientRect[]} */
  let clientRects = Array.from(
    node.getClientRects()
  ).map(clientRect => {
    // Contents of DOMRect get lost when returned from Runtime.evaluate call,
    // so we convert them to plain objects.
    const {width, height, left, top, right, bottom} = clientRect;
    return {width, height, left, top, right, bottom};
  });
  if (includeChildren) {
    for (const child of node.children) {
      clientRects = clientRects.concat(getClientRects(child));
    }
  }

  return clientRects;
}

/**
 * Check if node is in a block of text, such as paragraph with a bunch of links in it.
 * Makes a reasonable guess, but for example gets it wrong if the element is surounded by other
 * HTML elements instead of direct text nodes.
 * @param {Node} node
 * @returns {boolean}
 */
/* istanbul ignore next */
function nodeIsInTextBlock(node) {
  /**
   * @param {Node} node
   * @returns {boolean}
   */
  function isInline(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return true;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    const element = /** @type {Element} */ (node);
    return (
      getComputedStyle(element).display === 'inline' ||
      getComputedStyle(element).display === 'inline-block'
    );
  }

  /**
   * @param {Node} node
   */
  function hasTextNodeSiblingsFormingTextBlock(node) {
    if (!node.parentElement) {
      return false;
    }

    const parentElement = node.parentElement;

    const nodeText = node.textContent || '';
    const parentText = parentElement.textContent || '';
    if (parentText.length - nodeText.length < 5) {
      // Parent text mostly consists of this node, so the parent
      // is not a text block container
      return false;
    }

    const potentialSiblings = node.parentElement.childNodes;
    for (let i = 0; i < potentialSiblings.length; i++) {
      const sibling = potentialSiblings[i];
      if (sibling === node) {
        continue;
      }
      const siblingTextContent = (sibling.textContent || '').trim();
      if (
        sibling.nodeType === Node.TEXT_NODE &&
        siblingTextContent.length > 0
      ) {
        return true;
      }
    }

    return false;
  }

  if (!isInline(node)) {
    return false;
  }

  if (hasTextNodeSiblingsFormingTextBlock(node)) {
    return true;
  } else {
    if (node.parentElement) {
      return nodeIsInTextBlock(node.parentElement);
    } else {
      return false;
    }
  }
}

/**
 * @returns {LH.Artifacts.TapTarget[]}
 */
/* istanbul ignore next */
function gatherTapTargets() {
  const selector = TARGET_SELECTORS.join(',');

  /** @type {LH.Artifacts.TapTarget[]} */
  const targets = [];

  // @ts-ignore - getElementsInDocument put into scope via stringification
  Array.from(getElementsInDocument(selector)).forEach(node => {
    if (nodeIsInTextBlock(node)) {
      return;
    }

    const visibleClientRects = getVisibleClientRects(node);
    if (visibleClientRects.length === 0) {
      return;
    }

    targets.push({
      clientRects: visibleClientRects,
      snippet: truncate(node.outerHTML, 700),
      // @ts-ignore - getNodePath put into scope via stringification
      path: getNodePath(node),
      // @ts-ignore - getNodeSelector put into scope via stringification
      selector: getNodeSelector(node),
      href: node.getAttribute('href') || '',
    });
  });

  return targets;
}

/**
 * @param {function} fn
 * @param {(args: any[]) => any} getCacheKey
 */
/* istanbul ignore next */
function memoize(fn, getCacheKey) {
  const cache = new Map();
  /**
   * @this {any}
   * @param  {...any} args
   */
  function fnWithCaching(...args) {
    const cacheKey = getCacheKey(args);
    if (cache.get(cacheKey)) {
      return cache.get(cacheKey);
    }

    const result = fn.apply(this, args);
    cache.set(cacheKey, result);
    return result;
  }
  return fnWithCaching;
}

function filterClientRectsWithinAncestorsVisibleScrollArea(node, clientRects) {
  const parent = node.parentElement;
  if (!parent) {
    return clientRects;
  }
  if (getComputedStyle(parent).overflowY !== 'visible') {
    const parentBCR = parent.getBoundingClientRect();
    clientRects = clientRects.filter(cr => rectContains(parentBCR, cr));
  }
  if (parent.parentElement && parent.parentElement.tagName !== 'HTML') {
    return filterClientRectsWithinAncestorsVisibleScrollArea(
      parent.parentElement,
      clientRects
    );
  }
  return clientRects;
}

class TapTargets extends Gatherer {
  /**
   * @param {LH.Gatherer.PassContext} passContext
   * @return {Promise<LH.Artifacts.TapTarget[]>} All visible tap targets with their positions and sizes
   */
  afterPass(passContext) {
    const expression = `(function() {
      ${pageFunctions.getElementsInDocumentString};
      ${filterClientRectsWithinAncestorsVisibleScrollArea.toString()};
      ${nodeIsVisible.toString()};
      ${getVisibleClientRects.toString()};
      ${truncate.toString()};
      ${getClientRects.toString()};
      ${nodeIsInTextBlock.toString()};
      ${allClientRectsEmpty.toString()};
      ${rectContainsString};
      ${pageFunctions.getNodePathString};
      ${pageFunctions.getNodeSelectorString};
      ${gatherTapTargets.toString()};
      ${memoize.toString()};
      
      const TARGET_SELECTORS = ${JSON.stringify(TARGET_SELECTORS)};
      memoize(nodeIsVisible)

      return gatherTapTargets();
    
    })()`;

    return passContext.driver.evaluateAsync(expression);
  }
}

module.exports = TapTargets;
