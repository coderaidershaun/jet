/** Characters as a person counts them, and as the Rust limit counts them. @param {string} text */
export function countCodePoints(text) {
  return [...text].length;
}
