import * as core from '@actions/core'

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

const MAX_ATTEMPTS = 5
const RETRY_DELAY_MS = 5_000

class RetryableError extends Error {}

/** Retry transient failures; an ambiguous POST failure can duplicate a comment. */
export async function createComment(
  apiUrl: string,
  token: string,
  message: string
): Promise<Comment> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await createCommentAttempt(apiUrl, token, message)
    } catch (error) {
      if (!(error instanceof RetryableError)) throw error
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          `${error.message} (failed after ${MAX_ATTEMPTS} attempts).`
        )
      }
      core.warning(
        `Gitea request attempt ${attempt}/${MAX_ATTEMPTS} failed; retrying in 5 seconds (attempt ${attempt + 1}/${MAX_ATTEMPTS}).`
      )
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}

async function createCommentAttempt(
  apiUrl: string,
  token: string,
  message: string
): Promise<Comment> {
  const signal = AbortSignal.timeout(30_000)
  let receivedResponse = false
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
    receivedResponse = true

    if (!response.ok) {
      await response.body?.cancel()
      if (response.status >= 300 && response.status < 400) {
        throw new Error(
          `Gitea returned HTTP ${response.status}. Redirects are disabled; use the final HTTPS issue URL.`
        )
      }
      // Do not print response bodies: a proxy/server may echo credentials or text.
      const message = `Gitea returned HTTP ${response.status}. Check the issue URL, token permissions and server availability.`
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        throw new RetryableError(message)
      }
      throw new Error(message)
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
      throw new RetryableError('Gitea request timed out after 30 seconds.')
    }
    if (!receivedResponse) {
      throw new RetryableError(
        error instanceof Error ? error.message : String(error)
      )
    }
    throw error
  }
}
