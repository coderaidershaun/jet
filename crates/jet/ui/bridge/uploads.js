// Sends one file to the server as the raw body of a request, and deletes uploads no message will
// carry. `fetch` reports no upload progress, so the upload uses XMLHttpRequest.

/**
 * @param {File} file
 * @param {(fraction: number) => void} [onProgress]   called with 0 to 1 while the bytes go
 * @returns {Promise<import('../chat/thread/store.js').Attachment & { attached: boolean }>}
 *   the server's details of the saved file; rejects with `{ kind, message }`
 */
export function uploadFile(file, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/files?name=' + encodeURIComponent(file.name));
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      let value = null;
      try { value = JSON.parse(request.responseText); } catch { /* A refusal by the server's own limits has no JSON body. */ }
      if (request.status >= 200 && request.status < 300 && value) resolve(value);
      else if (value?.message) reject(value);
      else if (request.status === 413) reject({ kind: 'tooLarge', message: 'Over 32 MB' });
      else reject({ kind: 'io', message: 'The file could not be uploaded.' });
    };
    request.onerror = () => reject({ kind: 'network', message: 'The connection was lost.' });
    request.send(file);
  });
}

/**
 * Deletes uploads that no message will carry, as the page goes away. `keepalive` lets each request outlive the page.
 * @param {string[]} ids
 */
export function dropUploads(ids) {
  for (const id of ids) {
    fetch('/api/files/' + encodeURIComponent(id), { method: 'DELETE', keepalive: true })
      .catch((error) => console.warn('an unsent upload could not be deleted:', error));
  }
}
