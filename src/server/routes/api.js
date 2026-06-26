import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CONFIG } from '../config.js';
import db from '../db/database.js';
import { validateBody } from '../middleware/validate.js';
import { generateContent, generateTagsWithGemini } from '../services/ai-service.js';
import { postToNaver } from '../services/naver-service.js';
import { searchPexelsImages } from '../services/pexels-service.js';
import {
  emitLog,
  getAvailableAccount,
  getSchedulerStatus,
  processScheduledPosts,
  startScheduler,
  stopScheduler,
} from '../services/scheduler.js';
import { decrypt, encrypt } from '../utils/crypto.js';
import { getGlobalSetting } from '../utils/supabase.js';
import {
  createPostSchema,
  scheduleKeywordsSchema,
  schedulePostSchema,
} from '../utils/validation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// ─────────────────────────────────────────────
// ACCOUNTS
// ─────────────────────────────────────────────

// GET /accounts
router.get('/accounts', (req, res) => {
  db.all(
    'SELECT id, naver_id, status, round_robin_order FROM accounts WHERE user_id = ? ORDER BY round_robin_order ASC, id ASC',
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    },
  );
});

// POST /accounts
router.post('/accounts', (req, res) => {
  const { naver_id, naver_pw } = req.body;
  if (!naver_id || !naver_pw) {
    return res.status(400).json({ error: 'naver_id와 naver_pw가 필요합니다.' });
  }
  const encryptedPw = encrypt(naver_pw);

  // 기존 계정이 있는지 확인 (user_id가 NULL인 과거 데이터 호환성 처리)
  db.get('SELECT id, user_id FROM accounts WHERE naver_id = ?', [naver_id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    if (row) {
      if (!row.user_id) {
        // 기존에 등록되었으나 user_id가 없는 계정(업데이트 전 데이터)인 경우, 현재 유저의 소유로 편입(업데이트)
        db.run(
          'UPDATE accounts SET user_id = ?, naver_pw = ? WHERE id = ?',
          [req.user.id, encryptedPw, row.id],
          (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: row.id, naver_id, status: 'active' });
          },
        );
      } else {
        // 이미 주인이 있는 경우
        return res.status(400).json({ error: '이미 등록된 계정입니다.' });
      }
    } else {
      // 신규 등록
      db.run(
        'INSERT INTO accounts (user_id, naver_id, naver_pw) VALUES (?, ?, ?)',
        [req.user.id, naver_id, encryptedPw],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ id: this.lastID, naver_id, status: 'active' });
        },
      );
    }
  });
});

// DELETE /accounts/:id
router.delete('/accounts/:id', (req, res) => {
  const accountId = req.params.id;

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    // 1. 연결된 포스트의 account_id를 NULL로 변경 (데이터 보존)
    db.run(
      'UPDATE posts SET account_id = NULL WHERE account_id = ? AND user_id = ?',
      [accountId, req.user.id],
      (err) => {
        if (err) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: `데이터 연결 해제 실패: ${err.message}` });
        }

        // 2. 계정 삭제
        db.run(
          'DELETE FROM accounts WHERE id = ? AND user_id = ?',
          [accountId, req.user.id],
          function (err) {
            if (err) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: `계정 삭제 실패: ${err.message}` });
            }

            db.run('COMMIT', (err) => {
              if (err) return res.status(500).json({ error: `트랜잭션 완료 실패: ${err.message}` });
              res.json({
                message: '계정이 삭제되었으며, 기존 포스팅 기록은 보존되었습니다.',
                changes: this.changes,
              });
            });
          },
        );
      },
    );
  });
});

// PATCH /accounts/:id/status
router.patch('/accounts/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'status는 active 또는 paused여야 합니다.' });
  }

  const query =
    status === 'active'
      ? 'UPDATE accounts SET status = ?, login_fail_count = 0 WHERE id = ? AND user_id = ?'
      : 'UPDATE accounts SET status = ? WHERE id = ? AND user_id = ?';

  db.run(query, [status, req.params.id, req.user.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, status });
  });
});

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────

// GET /settings
router.get('/settings', (req, res) => {
  db.all('SELECT * FROM settings WHERE user_id = ?', [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const settings = rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    res.json(settings);
  });
});

// POST /settings
router.post('/settings', (req, res) => {
  const settings = req.body;
  db.serialize(() => {
    Object.entries(settings).forEach(([key, value]) => {
      db.run('INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)', [
        req.user.id,
        key,
        value,
      ]);
    });
    res.json({ success: true });
  });
});

// ─────────────────────────────────────────────
// AI GENERATE
// ─────────────────────────────────────────────

// 공통: DB에서 설정 가져오기
async function getSettingFromDB(userId, keyName) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT value FROM settings WHERE user_id = ? AND key = ?',
      [userId, keyName],
      (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.value : null);
      },
    );
  });
}

// ── Gemini API 키 리졸브 (Supabase -> 로컬 SQLite DB settings 백업) ──
async function resolveGeminiApiKey(userId, token) {
  const key = await getGlobalSetting('master_gemini_api_key', token);
  if (key && key !== 'YOUR_KEY_HERE') return key;

  return new Promise((resolve) => {
    db.get(
      "SELECT value FROM settings WHERE (user_id = ? OR user_id IS NULL) AND key = 'gemini_api_key' ORDER BY user_id DESC LIMIT 1",
      [userId || null],
      (err, row) => {
        if (err || !row || !row.value) return resolve(null);
        try {
          const decrypted = decrypt(row.value);
          resolve(decrypted !== 'YOUR_KEY_HERE' ? decrypted : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// GET /pexels/search (픽셀스 이미지 검색)
router.get('/pexels/search', async (req, res) => {
  const { query, per_page = 4 } = req.query;
  try {
    const pexelsApiKey = await getSettingFromDB(req.user.id, 'pexels_api_key');
    if (!pexelsApiKey || pexelsApiKey === 'YOUR_KEY_HERE') {
      return res.json([]);
    }
    const images = await searchPexelsImages(pexelsApiKey, query, Number(per_page));
    res.json(images);
  } catch (error) {
    console.error('[Pexels] Manual search route failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /generate  (원고 생성)
router.post('/generate', async (req, res) => {
  const { keyword, title, engine = 'gemini', image_keywords } = req.body;
  if (!keyword) return res.status(400).json({ error: '키워드를 입력해주세요.' });

  try {
    let aiConfig;
    let apiKey = null;
    if (engine === 'ollama') {
      const endpoint =
        (await getSettingFromDB(req.user.id, 'ollama_endpoint')) || 'http://localhost:11434';
      const model = (await getSettingFromDB(req.user.id, 'ollama_model')) || 'llama3';
      aiConfig = { endpoint, model };
    } else if (engine === 'openai' || engine === 'openclaw') {
      const endpoint =
        (await getSettingFromDB(req.user.id, 'openai_endpoint')) || 'https://api.openai.com/v1';
      const model = (await getSettingFromDB(req.user.id, 'openai_model')) || 'gpt-3.5-turbo';
      const savedKey = await getSettingFromDB(req.user.id, 'openai_api_key');
      const openaiApiKey = savedKey ? decrypt(savedKey) : '';
      aiConfig = { endpoint, apiKey: openaiApiKey, model };
    } else {
      apiKey = await resolveGeminiApiKey(req.user.id, req.token);
      if (!apiKey) {
        return res.status(500).json({ error: `API 호출에 실패했습니다. 관리자에게 문의하세요.` });
      }
      const model = (await getSettingFromDB(req.user.id, 'gemini_model')) || 'auto';
      aiConfig = { apiKey, model };
    }

    const content = await generateContent(engine, aiConfig, keyword, title);

    // AI 이미지 생성 복구 (Gemini API 키가 있을 경우)
    let imageUrl = '';
    if (engine === 'gemini' && apiKey) {
      try {
        const { generateImageWithGemini } = await import('../services/ai-service.js');
        const base64Image = await generateImageWithGemini(
          apiKey,
          keyword,
          content.title,
          content.content,
        );
        if (base64Image) {
          // base64 데이터를 로컬 이미지 파일로 저장하고 URL을 반환
          const uploadDir = CONFIG.UPLOAD_DIR;
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          const safeFileName = `${Date.now()}_gen.png`;
          const filePath = path.join(uploadDir, safeFileName);
          fs.writeFileSync(filePath, Buffer.from(base64Image, 'base64'));
          imageUrl = `http://${req.headers.host}/uploads/${safeFileName}`;
        }
      } catch (imageErr) {
        console.error('Gemini image generation error during /generate:', imageErr.message);
      }
    }

    // 픽셀스 이미지 자동 검색
    let pexelsImages = [];
    const pexelsApiKey = await getSettingFromDB(req.user.id, 'pexels_api_key');
    if (pexelsApiKey && pexelsApiKey !== 'YOUR_KEY_HERE') {
      try {
        let searchKeyword = keyword;
        if (image_keywords?.trim()) {
          const kwList = image_keywords
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean);
          if (kwList.length > 0) {
            searchKeyword = kwList[Math.floor(Math.random() * kwList.length)];
          }
        }
        pexelsImages = await searchPexelsImages(pexelsApiKey, searchKeyword, 4);
      } catch (pexelsErr) {
        console.error('[Pexels] Auto search failed during /generate:', pexelsErr.message);
      }
    }

    res.json({ ...content, imageUrl, pexelsImages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /generate/edit  ← 신규: 기존 글 AI로 수정
router.post('/generate/edit', async (req, res) => {
  const {
    content,
    instruction = '블로그 글을 더 자연스럽고 SEO에 최적화된 형태로 다듬어주세요.',
    engine = 'gemini',
  } = req.body;
  if (!content) return res.status(400).json({ error: '수정할 내용을 입력해주세요.' });

  try {
    let editedContent;
    if (engine === 'ollama') {
      const endpoint =
        (await getSettingFromDB(req.user.id, 'ollama_endpoint')) || 'http://localhost:11434';
      const model = (await getSettingFromDB(req.user.id, 'ollama_model')) || 'gemma4:e4b';

      let baseUrl = endpoint.trim();
      if (baseUrl.endsWith('/api/generate')) {
        baseUrl = baseUrl.replace(/\/api\/generate$/, '');
      } else if (baseUrl.endsWith('/api/generate/')) {
        baseUrl = baseUrl.replace(/\/api\/generate\/$/, '');
      }

      const url = baseUrl.endsWith('/') ? `${baseUrl}api/generate` : `${baseUrl}/api/generate`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'gemma4:e4b',
          prompt: `당신은 블로그 글 교정 전문가입니다. 다음 글을 수정해주세요.\n지시사항: ${instruction}\n\n원문:\n${content}`,
          stream: false,
        }),
      });
      const data = await response.json();
      editedContent = data.response;
    } else {
      const apiKey = await resolveGeminiApiKey(req.user.id, req.token);
      if (!apiKey) {
        return res.status(500).json({ error: `API 호출에 실패했습니다. 관리자에게 문의하세요.` });
      }
      const geminiModelPreference = (await getSettingFromDB(req.user.id, 'gemini_model')) || 'auto';

      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);

      let modelName = geminiModelPreference;
      if (modelName === 'auto') {
        modelName = 'gemini-2.5-flash-lite';
      }

      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(
        `다음 글을 수정해주세요.\n지시사항: ${instruction}\n\n원문:\n${content}`,
      );
      editedContent = result.response.text();
    }

    res.json({ editedContent });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────
// POSTS
// ─────────────────────────────────────────────

function cleanupOldPublishedPosts(userId) {
  db.run(
    `DELETE FROM posts WHERE user_id = ? AND status = 'published' AND id NOT IN (
      SELECT id FROM posts WHERE user_id = ? AND status = 'published' ORDER BY id DESC LIMIT 50
    )`,
    [userId, userId],
    (err) => {
      if (err) console.error('[Cleanup] 발행이력 정리 실패:', err.message);
    },
  );
}

// GET /posts (발행 히스토리)
router.get('/posts', (req, res) => {
  db.all(
    "SELECT p.*, a.naver_id FROM posts p LEFT JOIN accounts a ON p.account_id = a.id WHERE p.user_id = ? AND p.status IN ('published', 'failed') ORDER BY p.id DESC LIMIT 50",
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    },
  );
});

// DELETE /posts (전체 발행 이력 삭제 - 예약 및 대기 포스트 제외)
router.delete('/posts', (req, res) => {
  db.run(
    "DELETE FROM posts WHERE user_id = ? AND status IN ('published', 'failed')",
    [req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, changes: this.changes });
    },
  );
});

// POST /posts/batch-delete (선택한 발행 이력 다중 삭제)
router.post('/posts/batch-delete', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '삭제할 ID 배열이 필요합니다.' });
  }

  const placeholders = ids.map(() => '?').join(',');
  db.run(
    `DELETE FROM posts WHERE id IN (${placeholders}) AND user_id = ? AND status IN ('published', 'failed')`,
    [...ids, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, changes: this.changes });
    },
  );
});

// GET /posts/scheduled
router.get('/posts/scheduled', (req, res) => {
  db.all(
    "SELECT p.*, a.naver_id FROM posts p LEFT JOIN accounts a ON p.account_id = a.id WHERE p.user_id = ? AND p.status IN ('scheduled', 'pending', 'processing') ORDER BY p.scheduled_at ASC NULLS LAST, p.id DESC",
    [req.user.id],
    async (err, activePosts) => {
      if (err) return res.status(500).json({ error: err.message });

      // campaign_id 별로 그룹화할 대상 ID 추출
      const campaignIds = [
        ...new Set(activePosts.filter((p) => p.campaign_id).map((p) => p.campaign_id)),
      ];

      if (campaignIds.length === 0) {
        const result = activePosts.map((p) => ({ ...p, is_group: false }));
        return res.json(result);
      }

      const placeholders = campaignIds.map(() => '?').join(',');
      db.all(
        `SELECT p.*, a.naver_id FROM posts p LEFT JOIN accounts a ON p.account_id = a.id WHERE p.campaign_id IN (${placeholders}) ORDER BY p.scheduled_at ASC`,
        campaignIds,
        (err, allGroupPosts) => {
          if (err) return res.status(500).json({ error: err.message });

          const groups = {};
          for (const post of allGroupPosts) {
            if (!groups[post.campaign_id]) {
              groups[post.campaign_id] = [];
            }
            groups[post.campaign_id].push(post);
          }

          const finalizedList = [];
          const processedCampaigns = new Set();

          for (const post of activePosts) {
            if (post.campaign_id) {
              if (processedCampaigns.has(post.campaign_id)) continue;
              processedCampaigns.add(post.campaign_id);

              const groupPosts = groups[post.campaign_id] || [];
              const total = groupPosts.length;
              const published = groupPosts.filter((p) => p.status === 'published').length;
              const failed = groupPosts.filter((p) => p.status === 'failed').length;
              const active = groupPosts.filter(
                (p) =>
                  p.status === 'scheduled' || p.status === 'pending' || p.status === 'processing',
              ).length;

              const repPost =
                groupPosts.find(
                  (p) =>
                    p.status === 'scheduled' || p.status === 'pending' || p.status === 'processing',
                ) || post;

              finalizedList.push({
                id: `group_${post.campaign_id}`,
                campaign_id: post.campaign_id,
                is_group: true,
                post_type: 'keyword',
                title: `[자동 키워드 일괄] ${repPost.title} 외 ${total - 1}건`,
                keyword: repPost.keyword,
                naver_id: repPost.naver_id,
                scheduled_at: repPost.scheduled_at,
                status: repPost.status,
                total_count: total,
                published_count: published,
                active_count: active,
                failed_count: failed,
                group_posts: groupPosts,
              });
            } else {
              finalizedList.push({
                ...post,
                is_group: false,
              });
            }
          }

          res.json(finalizedList);
        },
      );
    },
  );
});

// POST /posts/:id/retry
router.post('/posts/:id/retry', (req, res) => {
  const { id } = req.params;
  db.run(
    "UPDATE posts SET status = 'scheduled', headless = 1, scheduled_at = datetime('now', '-1 minute') WHERE id = ? AND user_id = ? AND status = 'failed'",
    [id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0)
        return res
          .status(404)
          .json({ error: '실패 상태인 포스트를 찾을 수 없거나 이미 처리되었습니다.' });
      if (!getSchedulerStatus().isRunning) {
        startScheduler();
      }
      processScheduledPosts();
      res.json({ success: true, message: '포스트가 예약 목록으로 이동되었습니다.' });
    },
  );
});

// POST /posts/schedule
router.post('/posts/schedule', validateBody(schedulePostSchema), (req, res) => {
  const {
    account_id,
    title,
    content,
    image_url,
    scheduled_at,
    headless,
    post_type = 'manual',
    tags,
  } = req.body;

  // 1분 ~ 2분 사이의 랜덤한 오차(60,000ms ~ 120,000ms) 추가 적용
  let finalScheduledAt = scheduled_at;
  if (scheduled_at) {
    const randomOffsetMs = 60000 + Math.random() * 60000;
    finalScheduledAt = new Date(new Date(scheduled_at).getTime() + randomOffsetMs).toISOString();
  }

  const status = finalScheduledAt ? 'scheduled' : 'pending';
  const sql =
    'INSERT INTO posts (user_id, account_id, title, content, image_url, headless, scheduled_at, status, post_type, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  db.run(
    sql,
    [
      req.user.id,
      account_id || null,
      title,
      content,
      image_url || null,
      headless ? 1 : 0,
      finalScheduledAt || null,
      status,
      post_type,
      tags || null,
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (!getSchedulerStatus().isRunning) {
        startScheduler();
      }
      res.json({ id: this.lastID, status });
    },
  );
});

// POST /posts/schedule-keywords  (자동 키워드 예약 일괄 생성)
router.post('/posts/schedule-keywords', validateBody(scheduleKeywordsSchema), async (req, res) => {
  const {
    keywords,
    start_time,
    interval_hours = 0,
    interval_minutes = 0,
    account_id,
    use_round_robin,
    headless,
    engine = 'gemini',
    image_url, // Storing JSON string containing representative and content images
    split_rep_images,
    image_keywords,
    tags,
  } = req.body;

  const campaignId = Date.now();

  try {
    let aiConfig;
    if (engine === 'ollama') {
      const endpoint =
        (await getSettingFromDB(req.user.id, 'ollama_endpoint')) || 'http://localhost:11434';
      const model = (await getSettingFromDB(req.user.id, 'ollama_model')) || 'llama3';
      aiConfig = { endpoint, model };
    } else if (engine === 'openai' || engine === 'openclaw') {
      const endpoint =
        (await getSettingFromDB(req.user.id, 'openai_endpoint')) || 'https://api.openai.com/v1';
      const model = (await getSettingFromDB(req.user.id, 'openai_model')) || 'gpt-3.5-turbo';
      const savedKey = await getSettingFromDB(req.user.id, 'openai_api_key');
      const openaiApiKey = savedKey ? decrypt(savedKey) : '';
      aiConfig = { endpoint, apiKey: openaiApiKey, model };
    } else {
      const apiKey = await resolveGeminiApiKey(req.user.id, req.token);
      if (!apiKey) {
        return res.status(500).json({ error: `API 호출에 실패했습니다. 관리자에게 문의하세요.` });
      }
      const model = (await getSettingFromDB(req.user.id, 'gemini_model')) || 'auto';
      aiConfig = { apiKey, model };
    }

    const results = [];
    const intervalMs = (Number(interval_hours) * 60 + Number(interval_minutes)) * 60 * 1000;

    let parsedImages = { representative: [], content: [] };
    if (image_url) {
      try {
        parsedImages = JSON.parse(image_url);
      } catch (e) {
        console.error('image_url parse error', e);
      }
    }
    const repImages = parsedImages.representative || [];
    const contentImages = parsedImages.content || [];

    // 키워드별로 5개씩 총 5회차를 라운드 로빈 형태로 생성하여 예약 대기열에 한꺼번에 등록
    for (let step = 0; step < 5; step++) {
      for (let kwIdx = 0; kwIdx < keywords.length; kwIdx++) {
        const keyword = keywords[kwIdx].trim();
        if (!keyword) continue;

        const globalIdx = step * keywords.length + kwIdx;
        const totalCount = keywords.length * 5;

        emitLog(
          'info',
          `[자동 키워드 예약] 키워드 "${keyword}" (${step + 1}/5회차) 원고 생성 및 예약 등록 중 (${globalIdx + 1}/${totalCount})`,
          req.user.id,
        );

        try {
          const content = await generateContent(engine, aiConfig, keyword);

          let generatedTags = tags || '';
          if (!generatedTags && engine !== 'ollama' && aiConfig.apiKey) {
            generatedTags = await generateTagsWithGemini(
              aiConfig.apiKey,
              keyword,
              content.title,
              content.content,
            );
          }

          let repImgList = [];
          if (split_rep_images !== false) {
            const repImg = repImages.length > 0 ? repImages[globalIdx % repImages.length] : null;
            repImgList = repImg ? [repImg] : [];
          } else {
            repImgList = repImages;
          }

          let contentImgList = [];
          if (contentImages.length > 0) {
            const contentImg = contentImages[globalIdx % contentImages.length];
            contentImgList = contentImg ? [contentImg] : [];
          } else {
            // Pexels API 키가 설정되어 있으면 해당 키워드로 이미지 4장을 검색해 본문 이미지로 자동 삽입
            const pexelsApiKey = await getSettingFromDB(req.user.id, 'pexels_api_key');
            if (pexelsApiKey && pexelsApiKey !== 'YOUR_KEY_HERE') {
              try {
                let searchKeyword = keyword;
                if (image_keywords?.trim()) {
                  const kwList = image_keywords
                    .split(',')
                    .map((k) => k.trim())
                    .filter(Boolean);
                  if (kwList.length > 0) {
                    searchKeyword = kwList[globalIdx % kwList.length];
                  }
                }
                emitLog(
                  'info',
                  `[Pexels] 이미지 키워드 "${searchKeyword}"에 대한 이미지를 픽셀스에서 검색 중...`,
                  req.user.id,
                );
                const pexelsSearchUrls = await searchPexelsImages(pexelsApiKey, searchKeyword, 4);
                if (pexelsSearchUrls && pexelsSearchUrls.length > 0) {
                  contentImgList = pexelsSearchUrls;
                  emitLog(
                    'success',
                    `[Pexels] 이미지 ${pexelsSearchUrls.length}장을 수집하여 본문에 자동 매칭했습니다.`,
                    req.user.id,
                  );
                }
              } catch (pexelsErr) {
                emitLog(
                  'warn',
                  `[Pexels] 이미지 검색 실패: ${pexelsErr.message}. 이미지 없이 진행합니다.`,
                  req.user.id,
                );
              }
            }
          }

          const finalImageUrl = JSON.stringify({
            representative: repImgList,
            content: contentImgList,
          });

          // 시간 배정: 시작 시간 + (글의 순서 인덱스 * 간격)
          const timeOffsetMs = globalIdx * intervalMs;
          const baseScheduledTime = new Date(new Date(start_time).getTime() + timeOffsetMs);

          // 1분 ~ 2분 사이의 랜덤 오차 추가
          const randomOffsetMs = 60000 + Math.random() * 60000;
          const scheduledTimeWithOffset = new Date(baseScheduledTime.getTime() + randomOffsetMs);
          const finalScheduledAt = scheduledTimeWithOffset.toISOString();

          await new Promise((resolve, reject) => {
            const sql =
              'INSERT INTO posts (user_id, account_id, title, content, image_url, headless, scheduled_at, status, post_type, keyword, tags, republish_interval_ms, campaign_id, republish_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
            db.run(
              sql,
              [
                req.user.id,
                use_round_robin ? null : account_id || null,
                content.title,
                content.content,
                finalImageUrl,
                headless ? 1 : 0,
                finalScheduledAt,
                'scheduled',
                'keyword',
                keyword,
                generatedTags,
                null, // 한꺼번에 다 생성하므로 스케줄러에서 중복 재발행하지 않도록 null 설정
                campaignId,
                step + 1, // 회차 번호 저장
              ],
              function (err) {
                if (err) reject(err);
                else resolve(this.lastID);
              },
            );
          });

          results.push({ keyword, success: true, time: finalScheduledAt, step: step + 1 });
        } catch (err) {
          emitLog(
            'error',
            `[자동 키워드 예약] 키워드 "${keyword}" (${step + 1}/5회차) 생성 실패: ${err.message}`,
            req.user.id,
          );
          results.push({ keyword, success: false, step: step + 1, error: err.message });
        }
      }
    }

    if (!getSchedulerStatus().isRunning) {
      startScheduler();
      emitLog('info', '[자동 키워드 예약] 스케줄러가 기동되었습니다.', req.user.id);
    }

    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /posts/scheduled/:id
router.delete('/posts/scheduled/:id', (req, res) => {
  const targetId = req.params.id;
  if (typeof targetId === 'string' && targetId.startsWith('group_')) {
    const campaignId = Number(targetId.replace('group_', ''));
    db.run(
      "DELETE FROM posts WHERE campaign_id = ? AND user_id = ? AND status IN ('scheduled', 'pending', 'processing')",
      [campaignId, req.user.id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, changes: this.changes });
      },
    );
  } else {
    db.run(
      "DELETE FROM posts WHERE id = ? AND user_id = ? AND status IN ('scheduled', 'pending', 'processing', 'failed')",
      [req.params.id, req.user.id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, changes: this.changes });
      },
    );
  }
});

// PATCH /posts/scheduled/:id (예약 발행글 수정 - 제목, 본문, 키워드, 태그, 예약 시간)
router.patch('/posts/scheduled/:id', (req, res) => {
  const { title, content, keyword, scheduled_at, tags } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: '제목과 본문은 필수입니다.' });
  }

  // 1. 기존 포스트 가져와서 키워드가 변경되었는지 확인
  db.get(
    "SELECT * FROM posts WHERE id = ? AND user_id = ? AND status IN ('scheduled', 'pending', 'processing')",
    [req.params.id, req.user.id],
    async (err, post) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!post) {
        return res.status(404).json({ error: '수정 가능한 예약 포스트를 찾을 수 없습니다.' });
      }

      let finalTitle = title;
      let finalContent = content;
      let finalTags = tags || '';
      const newKeyword = keyword ? keyword.trim() : null;
      const oldKeyword = post.keyword ? post.keyword.trim() : null;

      // 키워드가 존재하고, 기존 키워드와 달라진 경우에만 AI 자동 재생성 수행
      if (newKeyword && newKeyword !== oldKeyword) {
        try {
          const engine = 'gemini';
          const apiKey = await resolveGeminiApiKey(req.user.id, req.token);
          if (!apiKey) {
            return res.status(500).json({ error: 'AI 재생성 실패: API 키가 유효하지 않습니다.' });
          }
          const model = (await getSettingFromDB(req.user.id, 'gemini_model')) || 'auto';
          const aiConfig = { apiKey, model };

          emitLog(
            'info',
            `[예약 수정] 키워드가 "${oldKeyword || '없음'}"에서 "${newKeyword}"(으)로 변경되어 AI 원고를 재작성합니다.`,
            req.user.id,
          );

          const aiResult = await generateContent(engine, aiConfig, newKeyword);
          finalTitle = aiResult.title;
          finalContent = aiResult.content;
          finalTags = await generateTagsWithGemini(apiKey, newKeyword, finalTitle, finalContent);
        } catch (aiErr) {
          return res.status(500).json({ error: `AI 원고 재작성 실패: ${aiErr.message}` });
        }
      }

      db.run(
        "UPDATE posts SET title = ?, content = ?, keyword = ?, scheduled_at = ?, tags = ?, status = 'scheduled' WHERE id = ? AND user_id = ? AND status IN ('scheduled', 'pending', 'processing')",
        [
          finalTitle,
          finalContent,
          newKeyword,
          scheduled_at || null,
          finalTags,
          req.params.id,
          req.user.id,
        ],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({
            success: true,
            message:
              newKeyword !== oldKeyword
                ? '키워드 변경에 따라 AI 원고가 재생성 및 수정되었습니다.'
                : '예약 포스트가 수정되었습니다.',
            post: {
              title: finalTitle,
              content: finalContent,
              keyword: newKeyword,
            },
          });
        },
      );
    },
  );
});

// DELETE /posts/:id (개별 발행 이력/로그 삭제)
router.delete('/posts/:id', (req, res) => {
  db.run(
    'DELETE FROM posts WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, changes: this.changes });
    },
  );
});

// POST /posts/:id/publish-now
router.post('/posts/:id/publish-now', (req, res) => {
  const { id } = req.params;
  db.run(
    "UPDATE posts SET status = 'scheduled', scheduled_at = datetime('now', '-1 minute') WHERE id = ? AND user_id = ? AND status IN ('scheduled', 'pending', 'processing', 'failed')",
    [id, req.user.id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!getSchedulerStatus().isRunning) {
        startScheduler();
      }
      processScheduledPosts();
      res.json({
        success: true,
        message:
          '스케줄러 백그라운드에서 강제 발행을 시작했습니다. (상태 업데이트까지 시간이 걸릴 수 있습니다.)',
      });
    },
  );
});

// POST /post (즉시 발행)
router.post('/post', validateBody(createPostSchema), async (req, res) => {
  const { account_id, title, content, image_url, headless, tags } = req.body;

  try {
    if (!getSchedulerStatus().isRunning) {
      startScheduler();
    }

    let account = null;
    if (account_id) {
      account = await new Promise((resolve, reject) => {
        db.get(
          'SELECT * FROM accounts WHERE id = ? AND user_id = ?',
          [account_id, req.user.id],
          (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
          },
        );
      });
    } else {
      account = await getAvailableAccount(req.user.id);
    }

    if (!account) {
      return res.status(404).json({ error: '사용 가능한 네이버 계정을 찾을 수 없습니다.' });
    }

    emitLog('info', `[수기 발행] 계정 ${account.naver_id}로 포스팅을 시작합니다.`, req.user.id);
    const decryptedAccount = { ...account, naver_pw: decrypt(account.naver_pw) };
    const result = await postToNaver(
      decryptedAccount,
      { title, content, image_url, user_id: req.user.id, tags },
      { headless },
    );

    const status = result.success ? 'published' : 'failed';
    db.run(
      "INSERT INTO posts (user_id, account_id, title, content, image_url, headless, scheduled_at, status, tags) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)",
      [
        req.user.id,
        account.id,
        title,
        content,
        image_url || null,
        headless ? 1 : 0,
        status,
        tags || null,
      ],
    );

    if (result.success) {
      // 성공 시 계정 카운트 및 순서 업데이트
      db.run(
        'UPDATE accounts SET daily_post_count = daily_post_count + 1, round_robin_order = round_robin_order + 1, last_post_date = ?, login_fail_count = 0 WHERE id = ?',
        [new Date().toISOString().split('T')[0], account.id],
      );
      cleanupOldPublishedPosts(req.user.id);
      emitLog('success', `[수기 발행] 성공적으로 포스팅되었습니다: ${title}`, req.user.id);
    } else {
      emitLog('error', `[수기 발행] 포스팅 실패: ${result.message}`, req.user.id);
    }

    res.json(result);
  } catch (error) {
    emitLog('error', `[수기 발행] 작업 중 오류 발생: ${error.message}`, req.user.id);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────
// TASK CONTROL (작업 시작/정지)
// ─────────────────────────────────────────────

// POST /task/start
router.post('/task/start', async (req, res) => {
  // 스케줄러 시작 전, 유저 토큰으로 Gemini API 키를 선제적으로 캐시
  try {
    const masterKey = await resolveGeminiApiKey(req.user.id, req.token);
    if (masterKey) {
      // 가져온 유효 키를 캐시 충전
      import('../utils/supabase.js').then(({ setGlobalSettingCache }) => {
        setGlobalSettingCache('master_gemini_api_key', masterKey);
      });
      console.log('[Task/Start] Gemini API key resolved and cached successfully.');
    }
  } catch (e) {
    console.warn('[Task/Start] Failed to resolve Gemini API key:', e.message);
  }

  const result = startScheduler();
  res.json({ success: result, status: getSchedulerStatus() });
});

// POST /task/stop
router.post('/task/stop', (_req, res) => {
  const result = stopScheduler();
  res.json({ success: result, status: getSchedulerStatus() });
});

// GET /task/status
router.get('/task/status', (_req, res) => {
  res.json(getSchedulerStatus());
});

// ─────────────────────────────────────────────
// LOGS
// ─────────────────────────────────────────────

// GET /logs
router.get('/logs', (req, res) => {
  const limit = req.query.limit || 100;
  db.all(
    'SELECT * FROM logs WHERE user_id = ? OR user_id IS NULL ORDER BY id DESC LIMIT ?',
    [req.user.id, limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.reverse());
    },
  );
});

// DELETE /logs
router.delete('/logs', (req, res) => {
  db.run('DELETE FROM logs WHERE user_id = ?', [req.user.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// POST /upload (로컬 base64 이미지 업로드)
router.post('/upload', (req, res) => {
  const { fileName, base64Data } = req.body;
  if (!fileName || !base64Data) {
    return res.status(400).json({ error: '파일명과 base64 데이터가 필요합니다.' });
  }

  try {
    const uploadDir = CONFIG.UPLOAD_DIR;
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // data:image/png;base64,... 헤더 제거
    const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const fileBuffer = Buffer.from(cleanBase64, 'base64');

    const fileExt = path.extname(fileName) || '.png';
    const safeFileName = `${Date.now()}_img${fileExt}`;
    const filePath = path.join(uploadDir, safeFileName);

    fs.writeFileSync(filePath, fileBuffer);

    // 호스트에 따른 정적 서빙 URL 생성
    const fileUrl = `http://${req.headers.host}/uploads/${safeFileName}`;
    res.json({ success: true, url: fileUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
