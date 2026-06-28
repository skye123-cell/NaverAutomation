import db from '../db/database.js';
import { decrypt } from '../utils/crypto.js';
import { getGlobalSetting } from '../utils/supabase.js';
import { generateContent, generateNextKeyword, generateTagsWithGemini } from './ai-service.js';
import { postToNaver } from './naver-service.js';

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

// 스케줄러 상태
let schedulerInterval = null;
let isRunning = false;
let activeWorkers = 0;
const MAX_WORKERS = 3;
let io = null; // Socket.io 인스턴스

/**
 * Socket.io 인스턴스 설정
 */
export function setIO(socketIO) {
  io = socketIO;
}

/**
 * 실시간 로그 emit + DB 저장
 */
export function emitLog(level, message, userId = null) {
  const log = {
    level,
    message,
    user_id: userId,
    created_at: new Date().toISOString(),
  };
  console.log(
    `[${level.toUpperCase()}]${userId ? ` [User:${userId.slice(0, 8)}]` : ''} ${message}`,
  );

  if (io) {
    io.emit('log', log);
  }

  db.run(
    'INSERT INTO logs (user_id, level, message) VALUES (?, ?, ?)',
    [userId, level, message],
    (err) => {
      if (err) console.error('Log save error:', err.message);
    },
  );
}

/**
 * 작업 상태 emit
 */
function emitTaskStatus() {
  if (io) {
    io.emit('task-status', {
      isRunning,
      activeWorkers,
    });
  }
}

/**
 * 유저별 사용 가능한 계정 조회 (1일 15회 한도 체크 포함)
 */
export async function getAvailableAccount(userId) {
  const today = new Date().toISOString().split('T')[0];

  return new Promise((resolve, reject) => {
    // 1. 오늘 날짜가 아니면 카운트 리셋
    db.run(
      'UPDATE accounts SET daily_post_count = 0, last_post_date = ? WHERE user_id = ? AND (last_post_date != ? OR last_post_date IS NULL)',
      [today, userId, today],
      (err) => {
        if (err) return reject(err);

        // 2. 한도가 남은 계정 중 가장 오랫동안 안 쓴 계정 선택
        db.get(
          "SELECT * FROM accounts WHERE user_id = ? AND status = 'active' AND daily_post_count < 15 ORDER BY round_robin_order ASC LIMIT 1",
          [userId],
          (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
          },
        );
      },
    );
  });
}

/**
 * 자동화 작업 시작
 */
export function startScheduler() {
  if (isRunning) {
    emitLog('warn', '스케줄러가 이미 실행 중입니다.');
    return false;
  }

  isRunning = true;
  emitLog('success', '스케줄러 자동화가 시작되었습니다.');
  emitTaskStatus();

  // 서버 시작 시/스케줄러 시작 시 stuck processing posts 복구
  db.run("UPDATE posts SET status = 'scheduled' WHERE status = 'processing'", () => {
    if (io) io.emit('posts-updated');
  });

  // 즉시 실행 및 10초 간격 체크
  processScheduledPosts();
  schedulerInterval = setInterval(() => {
    processScheduledPosts();
  }, 10 * 1000);
  return true;
}

/**
 * 자동화 작업 정지
 */
export function stopScheduler() {
  if (!isRunning) {
    emitLog('warn', '스케줄러가 이미 정지되어 있습니다.');
    return false;
  }

  isRunning = false;
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  emitLog('info', '자동화가 정지되었습니다.');
  emitTaskStatus();
  return true;
}

/**
 * 현재 스케줄러 상태 반환
 */
export function getSchedulerStatus() {
  return {
    isRunning,
    activeWorkers,
    maxWorkers: MAX_WORKERS,
  };
}

export async function processScheduledPosts() {
  if (activeWorkers >= MAX_WORKERS) return;

  try {
    // 0. 각 유저별 키워드 대기열 자동 꼬리물기 연장 체크
    await new Promise((resolve) => {
      db.all(
        "SELECT DISTINCT user_id FROM posts WHERE status IN ('scheduled', 'pending', 'processing')",
        [],
        async (err, rows) => {
          if (!err && rows) {
            for (const row of rows) {
              if (row.user_id) {
                try {
                  await checkAndExtendKeywordQueue(row.user_id);
                } catch (e) {
                  console.error(`[자동 연장] 유저 ${row.user_id} 대기열 연장 실패:`, e);
                }
              }
            }
          }
          resolve();
        },
      );
    });

    // 10분 이상 stuck된 processing 포스트가 있다면 failed 처리하여 무한 대기 방지
    await new Promise((resolve) => {
      db.run(
        "UPDATE posts SET status = 'failed' WHERE status = 'processing' AND (scheduled_at IS NULL OR datetime(scheduled_at) < datetime('now', '-10 minutes'))",
        () => {
          if (io) io.emit('posts-updated');
          resolve();
        },
      );
    });

    const today = new Date().toISOString().split('T')[0];
    await new Promise((resolve) => {
      db.run(
        'UPDATE accounts SET daily_post_count = 0, last_post_date = ? WHERE last_post_date != ? OR last_post_date IS NULL',
        [today, today],
        () => resolve(),
      );
    });

    db.all(
      "SELECT * FROM posts WHERE status IN ('scheduled', 'pending') AND (scheduled_at IS NULL OR datetime(scheduled_at) <= datetime('now'))",
      [],
      async (err, posts) => {
        if (err) {
          emitLog('error', `예약 포스트 조회 실패: ${err.message}`);
          return;
        }

        for (const post of posts) {
          if (activeWorkers >= MAX_WORKERS) break;

          activeWorkers++;
          emitTaskStatus();

          try {
            // 상태를 processing으로 변경하여 중복 실행 방지
            await new Promise((resolve, reject) => {
              db.run("UPDATE posts SET status = 'processing' WHERE id = ?", [post.id], (err) => {
                if (err) reject(err);
                else resolve();
              });
            });

            // 1. 계정 확인
            let account = null;
            if (post.account_id) {
              account = await new Promise((resolve, reject) => {
                db.get('SELECT * FROM accounts WHERE id = ?', [post.account_id], (err, row) => {
                  if (err) reject(err);
                  else resolve(row);
                });
              });
              if (account) {
                if (account.status !== 'active') {
                  emitLog(
                    'warn',
                    `예약 발행 실패: 선택된 계정(${account.naver_id})이 비활성화 상태입니다. (게시글: ${post.title})`,
                    post.user_id,
                  );
                  account = null;
                } else if (account.daily_post_count >= 15) {
                  emitLog(
                    'warn',
                    `예약 발행 실패: 선택된 계정(${account.naver_id})의 일일 발행 한도(15회)를 초과했습니다. (게시글: ${post.title})`,
                    post.user_id,
                  );
                  account = null;
                }
              }
            } else {
              account = await getAvailableAccount(post.user_id);
            }

            if (!account) {
              emitLog(
                'warn',
                `예약 발행 실패: 사용 가능한 네이버 계정이 없습니다. (게시글: ${post.title})`,
                post.user_id,
              );
              db.run("UPDATE posts SET status = 'failed' WHERE id = ?", [post.id]);
              continue;
            }

            emitLog(
              'info',
              `예약 포스트 [${post.title}] 발행을 시작합니다. (계정: ${account.naver_id})`,
              post.user_id,
            );

            // AI 원고 생성 (Rewrite) - 유사 문서 방지를 위한 자동 재작성 적용
            const finalTitle = post.title;
            const finalContent = post.content;

            // 2. 네이버 블로그 포스팅
            const decryptedAccount = { ...account, naver_pw: decrypt(account.naver_pw) };
            const postResult = await postToNaver(
              decryptedAccount,
              {
                title: finalTitle,
                content: finalContent,
                image_url: post.image_url,
                tags: post.tags,
                keyword: post.keyword,
                user_id: post.user_id,
              },
              {
                headless: true,
                isScheduler: true,
                onProgress: (level, msg) => emitLog(level, msg, post.user_id),
              },
            );

            if (postResult.success) {
              // 성공 시 상태 업데이트 및 계정 카운트/순서 업데이트
              db.run(
                "UPDATE posts SET status = 'published', account_id = ? WHERE id = ?",
                [account.id, post.id],
                () => {
                  if (io) io.emit('posts-updated');
                },
              );
              db.run(
                'UPDATE accounts SET daily_post_count = daily_post_count + 1, round_robin_order = round_robin_order + 1, last_post_date = ?, login_fail_count = 0 WHERE id = ?',
                [new Date().toISOString().split('T')[0], account.id],
                () => {
                  if (io) io.emit('posts-updated');
                },
              );
              cleanupOldPublishedPosts(post.user_id);
              emitLog('success', `예약 포스팅 성공: ${post.title}`, post.user_id);

              // ── 재발행 체인: 동일 키워드로 새 원고 생성 후 다음 예약 등록 ──
              if (post.republish_interval_ms && post.keyword && post.post_type === 'keyword') {
                try {
                  const currentCount = post.republish_count || 1;
                  if (currentCount >= 5) {
                    emitLog(
                      'info',
                      `[재발행] 키워드 "${post.keyword}"의 최대 재발행 제한(5회)에 도달하여 재발행 체인을 종료합니다.`,
                      post.user_id,
                    );
                  } else {
                    const nextScheduledAt = new Date(
                      Date.now() + Number(post.republish_interval_ms),
                    ).toISOString();
                    emitLog(
                      'info',
                      `[재발행] 키워드 "${post.keyword}" 새 원고 생성 중... (${currentCount + 1}/5회) 다음 발행: ${new Date(nextScheduledAt).toLocaleString('ko-KR')}`,
                      post.user_id,
                    );

                    // AI 엔진 설정 획득 (OpenAI/Openclaw, Ollama 또는 Gemini)
                    const engine = post.engine || 'gemini';
                    let aiConfig = null;

                    if (engine === 'openai' || engine === 'openclaw') {
                      const endpoint = await new Promise((resolve) => {
                        db.get(
                          "SELECT value FROM settings WHERE user_id = ? AND key = 'openai_endpoint'",
                          [post.user_id],
                          (err, row) => resolve(row ? row.value : 'https://api.openai.com/v1'),
                        );
                      });
                      const model = await new Promise((resolve) => {
                        db.get(
                          "SELECT value FROM settings WHERE user_id = ? AND key = 'openai_model'",
                          [post.user_id],
                          (err, row) => resolve(row ? row.value : 'gpt-3.5-turbo'),
                        );
                      });
                      const savedKey = await new Promise((resolve) => {
                        db.get(
                          "SELECT value FROM settings WHERE user_id = ? AND key = 'openai_api_key'",
                          [post.user_id],
                          (err, row) => resolve(row ? row.value : null),
                        );
                      });
                      const openaiApiKey = savedKey ? decrypt(savedKey) : '';
                      aiConfig = { endpoint, apiKey: openaiApiKey, model };
                    } else if (engine === 'ollama') {
                      const endpoint = await new Promise((resolve) => {
                        db.get(
                          "SELECT value FROM settings WHERE user_id = ? AND key = 'ollama_endpoint'",
                          [post.user_id],
                          (err, row) => resolve(row ? row.value : 'http://localhost:11434'),
                        );
                      });
                      const model = await new Promise((resolve) => {
                        db.get(
                          "SELECT value FROM settings WHERE user_id = ? AND key = 'ollama_model'",
                          [post.user_id],
                          (err, row) => resolve(row ? row.value : 'llama3'),
                        );
                      });
                      aiConfig = { endpoint, model };
                    } else {
                      // Gemini API 키 조회
                      let apiKey = await getGlobalSetting('master_gemini_api_key');
                      if (!apiKey || apiKey === 'YOUR_KEY_HERE') {
                        apiKey = await new Promise((resolve) => {
                          db.get(
                            "SELECT value FROM settings WHERE (user_id = ? OR user_id IS NULL) AND key = 'gemini_api_key' ORDER BY user_id DESC LIMIT 1",
                            [post.user_id],
                            (err, row) => {
                              if (err || !row || !row.value) return resolve(null);
                              try {
                                resolve(decrypt(row.value));
                              } catch {
                                resolve(null);
                              }
                            },
                          );
                        });
                      }
                      const model = await new Promise((resolve) => {
                        db.get(
                          "SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_model'",
                          [post.user_id],
                          (_err, row) => resolve(row ? row.value : 'auto'),
                        );
                      });
                      aiConfig = { apiKey, model };
                    }

                    if (aiConfig && (aiConfig.apiKey || engine === 'ollama')) {
                      const newContent = await generateContent(engine, aiConfig, post.keyword);
                      // [비활성화] 재발행 시 AI 태그 생성 기능 주석 처리 및 기존 태그 유지
                      // const newTags = await generateTagsWithGemini(
                      //   apiKey,
                      //   post.keyword,
                      //   newContent.title,
                      //   newContent.content,
                      // );
                      const newTags = post.tags || '';

                      await new Promise((resolve, reject) => {
                        db.run(
                          'INSERT INTO posts (user_id, account_id, title, content, image_url, headless, scheduled_at, status, post_type, keyword, tags, republish_interval_ms, campaign_id, republish_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                          [
                            post.user_id,
                            null, // 라운드로빈 사용
                            newContent.title,
                            newContent.content,
                            post.image_url,
                            post.headless,
                            nextScheduledAt,
                            'scheduled',
                            'keyword',
                            post.keyword,
                            newTags,
                            post.republish_interval_ms,
                            post.campaign_id || null,
                            currentCount + 1,
                          ],
                          (err) => {
                            if (err) reject(err);
                            else {
                              if (io) io.emit('posts-updated');
                              resolve();
                            }
                          },
                        );
                      });

                      emitLog(
                        'success',
                        `[재발행] 키워드 "${post.keyword}" 새 원고 예약 완료 (${currentCount + 1}/5회) → ${new Date(nextScheduledAt).toLocaleString('ko-KR')}`,
                        post.user_id,
                      );
                    } else {
                      emitLog(
                        'error',
                        `[재발행] 키워드 "${post.keyword}" 재발행 실패: Gemini API 키가 설정되지 않았거나 찾을 수 없습니다.`,
                        post.user_id,
                      );
                    }
                  }
                } catch (republishErr) {
                  emitLog(
                    'error',
                    `[재발행] 새 원고 생성 실패: ${republishErr.message}`,
                    post.user_id,
                  );
                }
              }
            } else {
              const failCount = postResult.failCount || 0;
              if (postResult.isLoginFailure && failCount < 5) {
                const nextRetryTime = new Date(Date.now() + 3 * 60 * 1000).toISOString();
                db.run(
                  "UPDATE posts SET status = 'scheduled', scheduled_at = ? WHERE id = ?",
                  [nextRetryTime, post.id],
                  () => {
                    if (io) io.emit('posts-updated');
                  },
                );
                emitLog(
                  'warn',
                  `[로그인 실패] 계정 로그인 실패로 3분 뒤 재발행을 시도합니다. (누적 실패: ${failCount}/5) → 예정 시각: ${new Date(nextRetryTime).toLocaleString('ko-KR')}`,
                  post.user_id,
                );
              } else {
                db.run("UPDATE posts SET status = 'failed' WHERE id = ?", [post.id], () => {
                  if (io) io.emit('posts-updated');
                });
                const reason = postResult.isLoginFailure ? ' (계정 일시정지)' : '';
                emitLog('error', `예약 포스팅 실패${reason}: ${postResult.message}`, post.user_id);
              }
            }
          } catch (error) {
            db.run("UPDATE posts SET status = 'failed' WHERE id = ?", [post.id], () => {
              if (io) io.emit('posts-updated');
            });
            emitLog('error', `예약 발행 중 오류 발생: ${error.message}`, post.user_id);
          } finally {
            activeWorkers--;
            emitTaskStatus();
          }
        }
      },
    );
  } catch (err) {
    emitLog('error', `스케줄러 작업 처리 중 치명적 오류: ${err.message}`);
  }
}

/**
 * 24시간 순환 발행: 남은 예약이 부족할 경우 대기열을 꼬리물기 연장 생성
 */
export async function checkAndExtendKeywordQueue(userId) {
  try {
    // 1. 해당 유저의 가장 늦은 예약 건 가져오기 (post_type = 'keyword')
    const lastPost = await new Promise((resolve) => {
      db.get(
        "SELECT * FROM posts WHERE user_id = ? AND post_type = 'keyword' ORDER BY scheduled_at DESC LIMIT 1",
        [userId],
        (err, row) => resolve(row || null),
      );
    });

    if (!lastPost) return; // 예약 내역이 아예 없으면 진행 안 함

    // 2. 남은 예약 대기열 건수 조회 (scheduled, pending, processing 상태)
    const remainingCount = await new Promise((resolve) => {
      db.get(
        "SELECT COUNT(*) as cnt FROM posts WHERE user_id = ? AND post_type = 'keyword' AND status IN ('scheduled', 'pending', 'processing')",
        [userId],
        (err, row) => resolve(row ? row.cnt : 0),
      );
    });

    const lastScheduledTime = new Date(lastPost.scheduled_at).getTime();
    const timeDiffMs = lastScheduledTime - Date.now();
    const isTimeUrgent = timeDiffMs < 12 * 60 * 60 * 1000; // 12시간 미만

    // 3. 조건 만족 시 (남은 예약이 1개 이하이거나 마지막 예약 시간이 12시간 미만으로 남았을 때)
    if (remainingCount > 0 && (remainingCount === 1 || isTimeUrgent)) {
      emitLog(
        'info',
        '[스케줄러] 키워드 대기열 소진이 감지되어 다음 날 분량(3개)을 7시간 간격으로 자동 연장 생성합니다.',
        userId,
      );

      // 고정 키워드 파싱 (태그 필드의 첫 번째 요소)
      let fixedKeyword = '';
      if (lastPost.tags) {
        const parsedTags = lastPost.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        if (parsedTags.length > 0) {
          fixedKeyword = parsedTags[0];
        }
      }
      if (!fixedKeyword) {
        fixedKeyword = lastPost.keyword; // 태그가 없을 경우 이전 키워드를 고정 키워드로 백업
      }

      // AI 엔진 설정 획득 (OpenAI/Openclaw, Ollama 또는 Gemini)
      const engine = lastPost.engine || 'gemini';
      let aiConfig = null;

      if (engine === 'openai' || engine === 'openclaw') {
        const endpoint = await new Promise((resolve) => {
          db.get(
            "SELECT value FROM settings WHERE user_id = ? AND key = 'openai_endpoint'",
            [userId],
            (err, row) => resolve(row ? row.value : 'https://api.openai.com/v1'),
          );
        });
        const model = await new Promise((resolve) => {
          db.get(
            "SELECT value FROM settings WHERE user_id = ? AND key = 'openai_model'",
            [userId],
            (err, row) => resolve(row ? row.value : 'gpt-3.5-turbo'),
          );
        });
        const savedKey = await new Promise((resolve) => {
          db.get(
            "SELECT value FROM settings WHERE user_id = ? AND key = 'openai_api_key'",
            [userId],
            (err, row) => resolve(row ? row.value : null),
          );
        });
        const openaiApiKey = savedKey ? decrypt(savedKey) : '';
        aiConfig = { endpoint, apiKey: openaiApiKey, model };
      } else if (engine === 'ollama') {
        const endpoint = await new Promise((resolve) => {
          db.get(
            "SELECT value FROM settings WHERE user_id = ? AND key = 'ollama_endpoint'",
            [userId],
            (err, row) => {
              resolve(row ? row.value : 'http://localhost:11434');
            },
          );
        });
        const model = await new Promise((resolve) => {
          db.get(
            "SELECT value FROM settings WHERE user_id = ? AND key = 'ollama_model'",
            [userId],
            (err, row) => {
              resolve(row ? row.value : 'llama3');
            },
          );
        });
        aiConfig = { endpoint, model };
      } else {
        // Gemini
        let apiKey = await getGlobalSetting('master_gemini_api_key');
        if (!apiKey || apiKey === 'YOUR_KEY_HERE') {
          apiKey = await new Promise((resolve) => {
            db.get(
              "SELECT value FROM settings WHERE (user_id = ? OR user_id IS NULL) AND key = 'gemini_api_key' ORDER BY user_id DESC LIMIT 1",
              [userId],
              (err, row) => {
                if (err || !row || !row.value) return resolve(null);
                try {
                  resolve(decrypt(row.value));
                } catch {
                  resolve(null);
                }
              },
            );
          });
        }
        if (!apiKey) {
          emitLog(
            'error',
            `[자동 연장] ${engine.toUpperCase()} API 키가 없어 키워드 대기열 연장에 실패했습니다.`,
            userId,
          );
          return;
        }
        const model = await new Promise((resolve) => {
          db.get(
            "SELECT value FROM settings WHERE user_id = ? AND key = 'gemini_model'",
            [userId],
            (err, row) => {
              resolve(row ? row.value : 'auto');
            },
          );
        });
        aiConfig = { apiKey, model };
      }

      let baseTime = lastScheduledTime;
      const intervalMs = 7 * 60 * 60 * 1000; // 7시간 고정 간격
      let previousTitle = lastPost.title;
      let previousContent = lastPost.content;

      for (let step = 0; step < 3; step++) {
        baseTime += intervalMs;
        const nextScheduledAt = new Date(baseTime).toISOString();
        let currentKeyword = '';

        if (step === 0) {
          // 1회차: 고정 키워드
          currentKeyword = fixedKeyword;
        } else {
          // 2, 3회차: 직전 글 기반 AI 자동 연관 키워드 추출
          try {
            currentKeyword = await generateNextKeyword(
              engine,
              aiConfig,
              previousTitle,
              previousContent,
            );
          } catch (e) {
            console.error('[자동 연장] 연관 키워드 추출 오류', e);
          }
          if (!currentKeyword) {
            currentKeyword = fixedKeyword; // fallback
          }
        }

        emitLog(
          'info',
          `[자동 연장] ${step + 1}회차 원고 생성 중 - 키워드: "${currentKeyword}"`,
          userId,
        );

        try {
          // 원고 생성
          const contentResult = await generateContent(engine, aiConfig, currentKeyword);

          const generatedTags = lastPost.tags || '';
          // [비활성화] 자동 연장 시 AI 태그 생성 기능 주석 처리 및 기존 태그 유지
          // if (engine !== 'ollama' && aiConfig.apiKey) {
          //   try {
          //     generatedTags = await generateTagsWithGemini(
          //       aiConfig.apiKey,
          //       currentKeyword,
          //       contentResult.title,
          //       contentResult.content,
          //     );
          //   } catch (e) {
          //     console.error('[자동 연장] 태그 생성 오류', e);
          //   }
          // }

          // DB에 예약글로 삽입
          await new Promise((resolve, reject) => {
            db.run(
              "INSERT INTO posts (user_id, account_id, title, content, image_url, headless, scheduled_at, status, post_type, keyword, tags, campaign_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 'keyword', ?, ?, ?)",
              [
                userId,
                null, // 라운드로빈 적용을 위한 null
                contentResult.title,
                contentResult.content,
                lastPost.image_url || null, // 이전 설정 이미지 상속
                lastPost.headless || 0,
                nextScheduledAt,
                currentKeyword,
                generatedTags,
                lastPost.campaign_id,
              ],
              (err) => (err ? reject(err) : resolve()),
            );
          });

          previousTitle = contentResult.title;
          previousContent = contentResult.content;
          emitLog(
            'success',
            `[자동 연장] ${step + 1}회차 예약 등록 성공 - 예약시각: ${new Date(nextScheduledAt).toLocaleString('ko-KR')}`,
            userId,
          );
        } catch (err) {
          emitLog('error', `[자동 연장] ${step + 1}회차 예약 생성 실패: ${err.message}`, userId);
          // 실패하더라도 루프는 이어서 진행하되 이전 Title/Content는 백업값 유지
        }
      }

      if (io) io.emit('posts-updated');
    }
  } catch (outerErr) {
    emitLog('error', `[자동 연장] 대기열 연장 프로세스 중 예외 발생: ${outerErr.message}`, userId);
  }
}
