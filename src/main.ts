import * as core from '@actions/core'
import { readFile } from 'node:fs/promises'
import { changelogDestinations } from './changelog'
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
    const to = core.getInput('to')
    const changelog = core.getInput('changelog', { trimWhitespace: false })
    if (!to && !changelog.trim()) {
      throw new Error('Provide an issue URL in "to" or text in "changelog".')
    }
    const destinations = new Set([
      ...(to ? [commentsUrl(to)] : []),
      ...changelogDestinations(changelog)
    ])
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
    if (destinations.size === 0) {
      core.info(
        'No HTTPS Gitea issue links found in changelog; nothing to send.'
      )
    }
    for (const apiUrl of destinations) {
      for (const text of nonEmptyMessages) {
        const comment = await createComment(apiUrl, token, text)
        ids.push(comment.id)
        urls.push(comment.html_url)
        updateOutputs()
        core.info(`Created Gitea comment ${comment.id}.`)
      }
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}
