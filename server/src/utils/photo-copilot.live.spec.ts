import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import z from 'zod';
import { CodexNotification, PhotoCodexClient } from 'src/utils/photo-copilot.js';

/** 显式启用才调用真实 Codex；只发送本测试生成的几何图形，不使用私人照片或真实 EXIF。 */
describe.runIf(process.env.PHOTO_COPILOT_LIVE_TEST === '1')('Photo Copilot real Codex', () => {
  it('sees a synthetic original, remembers a prior turn, streams and interrupts', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'photo-copilot-live-'));
    const cwd = path.join(home, 'workspace');
    await mkdir(cwd);
    await copyFile(
      path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'auth.json'),
      path.join(home, 'auth.json'),
    );
    await writeFile(
      path.join(home, 'config.toml'),
      'approval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n[features]\nshell_tool = false\nview_image = false\napps = false\n',
    );
    const image = path.join(cwd, 'synthetic.png');
    await sharp(
      Buffer.from(
        '<svg width="600" height="300"><rect width="600" height="300" fill="white"/><rect x="40" y="60" width="160" height="160" fill="orange"/><circle cx="430" cy="140" r="90" fill="green"/></svg>',
      ),
    )
      .png()
      .toFile(image);
    const client = new PhotoCodexClient({
      executable: process.env.IMMICH_PHOTO_COPILOT_EXECUTABLE || 'codex',
      home,
      cwd,
    });
    const events: CodexNotification[] = [];
    client.on('notification', (event) => {
      events.push(event);
    });
    try {
      await client.connect();
      const thread = await client.request(
        'thread/start',
        {
          ephemeral: true,
          sandbox: 'read-only',
          approvalPolicy: 'never',
          model: process.env.IMMICH_PHOTO_COPILOT_MODEL || 'gpt-6.1-sol',
        },
        z.object({ thread: z.object({ id: z.string() }) }),
      );
      /** @returns 当前轮真正完成的通知，最长等待 90 秒；断线或超时失败。 */
      const completion = () =>
        new Promise<CodexNotification>((resolve, reject) => {
          const timer = setTimeout(() => {
            client.off('notification', receive);
            reject(new Error('Real Codex turn did not finish'));
          }, 90_000);
          /** @param event 官方通知；只接收当前测试线程的完成事件并清理监听器。 */
          function receive(event: CodexNotification) {
            if (!(event.method === 'turn/completed' && event.params.threadId === thread.thread.id)) {
              return;
            }

            clearTimeout(timer);
            client.off('notification', receive);
            resolve(event);
          }
          client.on('notification', receive);
        });
      const firstDone = completion();
      await client.request(
        'turn/start',
        {
          threadId: thread.thread.id,
          effort: 'low',
          input: [
            {
              type: 'text',
              text: 'Remember the codeword orchard47. Describe the colors and shapes in this image in one short English sentence.',
            },
            { type: 'localImage', path: image },
          ],
          additionalContext: {
            synthetic: {
              kind: 'untrusted',
              name: 'photo_context_v1',
              value: JSON.stringify({ assetId: 'synthetic-test', fileName: 'synthetic.png' }),
            },
          },
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
        },
        z.unknown(),
      );
      const first = await firstDone;
      expect(first.params.turn?.status).toBe('completed');
      const visible = events
        .filter((event) => event.method === 'item/agentMessage/delta')
        .map((event) => event.params.delta)
        .join('');
      expect(visible.toLowerCase()).toContain('orange');
      expect(visible.toLowerCase()).toContain('green');
      expect(visible.toLowerCase()).toContain('circle');
      expect(events.some((event) => event.method === 'item/agentMessage/delta')).toBe(true);
      events.length = 0;
      const secondDone = completion();
      await client.request(
        'turn/start',
        {
          threadId: thread.thread.id,
          effort: 'low',
          input: [
            { type: 'text', text: 'What was the codeword from my previous message? Reply with only the codeword.' },
          ],
        },
        z.unknown(),
      );
      const second = await secondDone;
      expect(second.params.turn?.status).toBe('completed');
      expect(
        events
          .filter((event) => event.method === 'item/agentMessage/delta')
          .map((event) => event.params.delta)
          .join(''),
      ).toContain('orchard47');
      const thirdDone = completion();
      const turn = await client.request(
        'turn/start',
        {
          threadId: thread.thread.id,
          input: [{ type: 'text', text: 'Write an extremely long, detailed essay about the two shapes.' }],
        },
        z.object({ turn: z.object({ id: z.string() }) }),
      );
      await client.request('turn/interrupt', { threadId: thread.thread.id, turnId: turn.turn.id }, z.unknown());
      const third = await thirdDone;
      expect(third.params.turn?.status).toBe('interrupted');
    } finally {
      client.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 240_000);
});
