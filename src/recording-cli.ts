import { z } from 'zod'
import { receiveRecording, recordingDoctor, recordingOptions } from './recordings.js'

/** Completion paths travel as JSON on stdin, never as executable shell text. */
export async function runRecordingCli(args: string[]): Promise<number> {
  try {
    if (args.length === 1 && args[0] === 'recording-doctor') {
      console.log(JSON.stringify(await recordingDoctor(recordingOptions()), null, 2))
      return 0
    }
    const pathInput = args.length === 2 && args[1] === '--path-stdin'
    if (args[0] !== 'recording-complete' || (args.length !== 1 && !pathInput)) throw new Error('Usage: ecamm-mcp recording-complete [--path-stdin] < input (default input is JSON: {"path":"/absolute/recording.mp4"})')
    let bytes = 0
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > 16384) throw new Error('Completion input exceeds 16 KB.')
      chunks.push(buffer)
    }
    const input = Buffer.concat(chunks).toString('utf8')
    const { path } = z.object({ path: z.string().min(1).max(4096) }).strict().parse(pathInput
      ? { path: input.replace(/\r?\n$/, '') } : JSON.parse(input))
    console.log(JSON.stringify(await receiveRecording(path, recordingOptions())))
    return 0
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
}
