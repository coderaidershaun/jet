// The words under the gear: the model and thinking level the next reply will use.

/**
 * @param {string} modelAlias   such as "sonnet"
 * @param {string} effort   such as "medium"
 */
export function captionFor(modelAlias, effort) {
  return modelAlias.charAt(0).toUpperCase() + modelAlias.slice(1) + ' · ' + effort;
}
