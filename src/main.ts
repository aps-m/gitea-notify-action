import * as core from '@actions/core'
import { readFile } from 'node:fs/promises'
import { commentsUrl, createComment } from './gitea'

export async function run(): Promise<void> {
  const ids: number[] = []
  const urls: string[] = []
  const updateOutputs = (): void => {
    core.setOutput('comment_ids', JSON.stringify(ids))
    core.setOutput('comment_urls', JSON.stringify(urls))
    core.setOutput('comment_count', ids.length)
  }

  try {
    const token = core.getInput('token', { required: true })
    core.setSecret(token)
    const apiUrl = commentsUrl(core.getInput('to', { required: true }))
    const message = core.getInput('message', { trimWhitespace: false })
    const messageFile = core.getInput('message_file')

    // Read and validate all local input before publishing anything.
    const messages: string[] = []
    if (messageFile) messages.push(await readFile(messageFile, 'utf-8'))
    messages.push(message)
    const nonEmptyMessages = messages.filter(text => text.trim() !== '')
    if (nonEmptyMessages.length === 0) {
      throw new Error('Provide non-empty text in "message" or "message_file".')
    }

    updateOutputs()
    for (const text of nonEmptyMessages) {
      const comment = await createComment(apiUrl, token, text)
      ids.push(comment.id)
      urls.push(comment.html_url)
      updateOutputs()
      core.info(`Created Gitea comment ${comment.id}.`)
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}
