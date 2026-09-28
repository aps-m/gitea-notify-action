export interface Comment {
  id: number
  html_url: string
}

/** Convert the browser issue URL to the API endpoint, preserving a subpath. */
export function commentsUrl(issueUrl: string): string {
  let url: URL
  try {
    url = new URL(issueUrl)
  } catch {
    throw new Error('Input "to" must be an absolute HTTPS Gitea issue URL.')
  }

  if (url.protocol !== 'https:') {
    throw new Error('Input "to" must use HTTPS.')
  }
  if (url.username || url.password) {
    throw new Error('Input "to" must not contain credentials; use "token".')
  }

  const match = url.pathname.match(
    /^(.*)\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/?$/
  )
  if (!match) {
    throw new Error(
      'Input "to" must have the form https://host/owner/repo/issues/42 (optionally under a subpath).'
    )
  }

  const [, prefix, owner, repo, index] = match
  // Query parameters and fragments belong to the web UI, not the API request.
  return `${url.origin}${prefix}/api/v1/repos/${owner}/${repo}/issues/${index}/comments`
}

/** POST once: retrying an ambiguous network failure could duplicate a comment. */
export async function createComment(
  apiUrl: string,
  token: string,
  message: string
): Promise<Comment> {
  const signal = AbortSignal.timeout(30_000)
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ body: message }),
      redirect: 'manual',
      signal
    })

    if (!response.ok) {
      await response.body?.cancel()
      if (response.status >= 300 && response.status < 400) {
        throw new Error(
          `Gitea returned HTTP ${response.status}. Redirects are disabled; use the final HTTPS issue URL.`
        )
      }
      // Do not print response bodies: a proxy/server may echo credentials or text.
      throw new Error(
        `Gitea returned HTTP ${response.status}. Check the issue URL, token permissions and server availability.`
      )
    }

    let comment: unknown
    try {
      comment = await response.json()
    } catch {
      throw new Error('Gitea returned an invalid JSON response.')
    }
    if (
      typeof comment !== 'object' ||
      comment === null ||
      !('id' in comment) ||
      typeof comment.id !== 'number' ||
      !Number.isSafeInteger(comment.id) ||
      comment.id <= 0 ||
      !('html_url' in comment) ||
      typeof comment.html_url !== 'string' ||
      comment.html_url.trim() === ''
    ) {
      throw new Error('Gitea returned an invalid comment response.')
    }

    return { id: comment.id, html_url: comment.html_url }
  } catch (error) {
    if (signal.aborted) {
      throw new Error('Gitea request timed out after 30 seconds.')
    }
    throw error
  }
}
