import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Google Gemini 모델 자동 선택 로직
 */
function _selectBestGeminiModel(_content) {
  return 'gemini-2.5-flash-lite';
}

/**
 * Google Gemini를 이용한 텍스트 생성 (자동 모델 선택 및 Fallback 포함)
 */
async function generateWithGemini(apiKey, keyword, modelPreference = 'auto', title = null) {
  const genAI = new GoogleGenerativeAI(apiKey);

  // 모델 결정 (유저 요청에 따라 2.5 Flash Lite 우선)
  let modelName = modelPreference === 'auto' ? 'gemini-2.5-flash-lite' : modelPreference;

  const availableModels = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
  ];
  if (!availableModels.includes(modelName)) {
    modelName = 'gemini-2.5-flash-lite';
  }

  console.log(`[Gemini] Starting generation with model: ${modelName}`);

  try {
    const model = genAI.getGenerativeModel({ model: modelName });

    let prompt = '';
    if (title) {
      prompt = `당신은 블로그 포스팅 전문가입니다. 반드시 아래 형식을 지켜주세요.
[TITLE]${title}[/TITLE]
[CONTENT]본문[/CONTENT]

지정된 제목: ${title}
주제 키워드: ${keyword}
지정된 제목에 가장 어울리고 유익한 블로그 포스팅 본문(원고)을 정성껏 작성해줘.`;
    } else {
      prompt = `당신은 블로그 포스팅 전문가입니다. 반드시 아래 형식을 지켜주세요.
[TITLE]제목[/TITLE]
[CONTENT]본문[/CONTENT]

주제: ${keyword}
원고를 작성해줘.`;
    }

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const fullText = response.text();
    const parsed = parseAIResponse(fullText);
    if (title) {
      parsed.title = title; // 제목 강제 고정
    }
    return { ...parsed, modelUsed: modelName };
  } catch (error) {
    // 429 에러 발생 시 리트라이 로직
    if (error.message.includes('429') || error.message.includes('quota')) {
      console.warn(`[Gemini] ${modelName} limit reached. Waiting for fallback...`);
    }
    throw error;
  }
}

/**
 * Google Gemini를 이용한 기존 원고 재작성 (Rewrite)
 */
export async function generateRewriteWithGemini(
  apiKey,
  originalTitle,
  originalContent,
  modelPreference = 'auto',
) {
  const genAI = new GoogleGenerativeAI(apiKey);

  // 유저 명시적 요청: gemini-2.5-flash-lite 사용
  const modelName = modelPreference === 'auto' ? 'gemini-2.5-flash-lite' : modelPreference;

  console.log(`[Gemini/Rewrite] Rewriting content with model: ${modelName}`);

  try {
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = `당신은 블로그 포스팅 전문가입니다. 아래 제공된 [원본 제목]과 [원본 본문]의 핵심 내용을 유지하되, 
네이버의 유사 문서 판독을 피할 수 있도록 완전히 새로운 문장 구조와 표현으로 다시 작성해주세요.
반드시 아래 형식을 지켜주세요.
[TITLE]새로운 제목[/TITLE]
[CONTENT]새로운 본문[/CONTENT]

[원본 제목]: ${originalTitle}
[원본 본문]: ${originalContent}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const fullText = response.text();
    const parsed = parseAIResponse(fullText);
    return { ...parsed, modelUsed: modelName };
  } catch (error) {
    console.error('Gemini Rewrite Error:', error);
    throw error;
  }
}

/**
 * Ollama를 이용한 텍스트 생성
 */
async function generateWithOllama(endpoint, model, keyword, title = null) {
  try {
    // 사용자가 입력한 엔드포인트가 없으면 로컬 기본값(11434) 사용
    let baseUrl = (endpoint || 'http://localhost:11434').trim();
    if (baseUrl.endsWith('/api/generate')) {
      baseUrl = baseUrl.replace(/\/api\/generate$/, '');
    } else if (baseUrl.endsWith('/api/generate/')) {
      baseUrl = baseUrl.replace(/\/api\/generate\/$/, '');
    }

    // 최종 URL 조립
    const url = baseUrl.endsWith('/') ? `${baseUrl}api/generate` : `${baseUrl}/api/generate`;
    console.log(`[Ollama] Requesting URL: ${url} (Model: ${model || 'gemma4'})`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'gemma4',
        prompt: title
          ? `당신은 블로그 포스팅 전문가입니다. 반드시 아래 형식을 지켜주세요.\n[TITLE]${title}[/TITLE]\n[CONTENT]본문[/CONTENT]\n\n지정된 제목 "${title}"과 주제 "${keyword}"에 맞춰 블로그 포스팅 본문을 작성해줘.`
          : `당신은 블로그 포스팅 전문가입니다. 반드시 아래 형식을 지켜주세요.\n[TITLE]제목[/TITLE]\n[CONTENT]본문[/CONTENT]\n\n${keyword} 주제로 블로그 포스팅 원고를 작성해줘.`,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`);
    }

    const data = await response.json();
    const fullText = data.response; // /api/generate는 'response' 필드 사용
    const parsed = parseAIResponse(fullText);
    if (title) {
      parsed.title = title; // 제목 강제 고정
    }
    return { ...parsed, modelUsed: model || 'gemma4' };
  } catch (error) {
    console.error('Ollama Content Generation Error:', error);
    throw new Error(`Failed to generate with Ollama: ${error.message}`);
  }
}

/**
 * OpenAI 호환 API (Openclaw 등)를 이용한 텍스트 생성
 */
async function generateWithOpenAI(endpoint, apiKey, model, keyword, title = null) {
  try {
    let baseUrl = (endpoint || 'https://api.openai.com/v1').trim();
    if (!baseUrl.endsWith('/chat/completions')) {
      baseUrl = baseUrl.endsWith('/')
        ? `${baseUrl}chat/completions`
        : `${baseUrl}/chat/completions`;
    }

    console.log(`[OpenAI] Requesting URL: ${baseUrl} (Model: ${model || 'gpt-3.5-turbo'})`);

    const prompt = title
      ? `당신은 블로그 포스팅 전문가입니다. 반드시 아래 형식을 지켜주세요.\n[TITLE]${title}[/TITLE]\n[CONTENT]본문[/CONTENT]\n\n지정된 제목 "${title}"과 주제 "${keyword}"에 맞춰 블로그 포스팅 본문을 작성해줘.`
      : `당신은 블로그 포스팅 전문가입니다. 반드시 아래 형식을 지켜주세요.\n[TITLE]제목[/TITLE]\n[CONTENT]본문[/CONTENT]\n\n${keyword} 주제로 블로그 포스팅 원고를 작성해줘.`;

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    const fullText = data.choices[0].message.content;
    const parsed = parseAIResponse(fullText);
    if (title) {
      parsed.title = title;
    }
    return { ...parsed, modelUsed: model || 'gpt-3.5-turbo' };
  } catch (error) {
    console.error('OpenAI Content Generation Error:', error);
    throw new Error(`Failed to generate with OpenAI: ${error.message}`);
  }
}

/**
 * AI 응답 파싱 (제목/본문 추출)
 */
function parseAIResponse(fullText) {
  const titleMatch = fullText.match(/\[TITLE\](.*?)(?:\[\/TITLE\]|$)/s);
  const contentMatch = fullText.match(/\[CONTENT\](.*?)(?:\[\/CONTENT\]|$)/s);

  const title = titleMatch ? titleMatch[1].trim() : '제목 없음';
  const content = contentMatch ? contentMatch[1].trim() : fullText.trim();

  return { title, content };
}

/**
 * 통합 콘텐츠 생성 함수
 */
export async function generateContent(engine, apiKeyOrConfig, keyword, title = null) {
  if (engine === 'gemini') {
    const { apiKey, model } = apiKeyOrConfig;
    const actualKey = typeof apiKeyOrConfig === 'string' ? apiKeyOrConfig : apiKey;
    const actualModel = typeof apiKeyOrConfig === 'string' ? 'auto' : model;
    return await generateWithGemini(actualKey, keyword, actualModel, title);
  } else if (engine === 'ollama') {
    const { endpoint, model } = apiKeyOrConfig;
    return await generateWithOllama(endpoint, model, keyword, title);
  } else if (engine === 'openai' || engine === 'openclaw') {
    const { endpoint, apiKey, model } = apiKeyOrConfig;
    return await generateWithOpenAI(endpoint, apiKey, model, keyword, title);
  } else {
    throw new Error('지원하지 않는 엔진입니다. Gemini, Ollama 또는 OpenAI를 사용해주세요.');
  }
}

/**
 * Google Gemini를 이용한 태그 자동 생성
 */
export async function generateTagsWithGemini(apiKey, keyword, title, content) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = 'gemini-2.5-flash-lite';

  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const prompt = `당신은 네이버 블로그 SEO 전문가입니다. 
다음 제공된 키워드, 제목, 본문을 바탕으로 이 포스팅에 가장 적합한 5~10개의 검색 최적화(SEO) 태그를 추출하거나 생성해주세요.
반드시 콤마(,)로만 구분된 하나의 문자열로 응답해야 합니다. 
(예시: 맛집,서울여행,데이트코스,가성비)
앞뒤로 다른 설명이나 기호 없이 오직 태그만 콤마로 구분해서 출력하세요.

키워드: ${keyword || '없음'}
제목: ${title || '없음'}
본문: ${content ? `${content.substring(0, 1000)}...` : '없음'}
`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const tagsStr = response.text().trim();
    return tagsStr
      .split(',')
      .map((t) => t.trim().replace(/^#/, ''))
      .filter(Boolean)
      .join(', ');
  } catch (error) {
    console.error('Gemini Tag Generation Error:', error);
    return ''; // 오류 시 빈 태그 반환
  }
}

/**
 * Google Gemini (Imagen)을 이용한 본문 대체용 이미지 생성
 */
export async function generateImageWithGemini(apiKey, keyword, _title, _content) {
  try {
    // 블로그 포스팅과 어울리는 자연스럽고 감성적인 이미지 프롬프트 작성
    const prompt = `A highly realistic, aesthetic, and visually appealing blog cover image representing the following topic: ${keyword}. No text in the image. High quality, detailed.`;

    // AI Studio의 Gemini 2.5 Flash Image (Nano Banana) 모델 사용
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Image Gen API Error:', errText);
      return null;
    }

    const data = await response.json();
    if (data.candidates && data.candidates.length > 0) {
      const parts = data.candidates[0].content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          return part.inlineData.data;
        }
      }
    }
    return null;
  } catch (error) {
    console.error('generateImageWithGemini error:', error);
    return null;
  }
}

/**
 * Google Gemini를 이용한 이전 글 기반 연관 키워드 추출
 */
export async function generateNextKeywordWithGemini(apiKey, title, content) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = 'gemini-2.5-flash-lite';

  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const prompt = `당신은 네이버 블로그 SEO 전문가입니다.
다음 제공된 이전 블로그 글의 제목과 본문을 분석하여, 자연스럽게 이어지거나 독자가 흥미를 가질 만한 후속 연관 키워드 1개를 단어 형태로만 추천해주세요.
반드시 다른 설명이나 기호 없이 오직 키워드 1개만 단어로 응답해야 합니다. 
(예시: 신용카드 추천)

이전 글 제목: ${title}
이전 글 본문: ${content.substring(0, 1000)}...
`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response
      .text()
      .trim()
      .replace(/^[^a-zA-Z0-9가-힣\s]+|[^a-zA-Z0-9가-힣\s]+$/g, '');
  } catch (error) {
    console.error('Gemini Next Keyword Generation Error:', error);
    return '';
  }
}

/**
 * OpenAI 호환 API를 이용한 이전 글 기반 연관 키워드 추출
 */
export async function generateNextKeywordWithOpenAI(endpoint, apiKey, model, title, content) {
  try {
    let baseUrl = (endpoint || 'https://api.openai.com/v1').trim();
    if (!baseUrl.endsWith('/chat/completions')) {
      baseUrl = baseUrl.endsWith('/')
        ? `${baseUrl}chat/completions`
        : `${baseUrl}/chat/completions`;
    }

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-3.5-turbo',
        messages: [
          {
            role: 'user',
            content: `당신은 블로그 SEO 전문가입니다. 아래 제공된 블로그 글의 제목과 본문을 분석하여, 자연스럽게 이어지거나 독자가 흥미를 가질 만한 후속 연관 키워드 1개를 단어 형태로만 추천해주세요. 다른 설명 없이 오직 단어(예: 신용카드 추천)로만 응답하세요.\n\n제목: ${title}\n본문: ${content.substring(0, 500)}...`,
          },
        ],
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }
    const data = await response.json();
    return data.choices[0].message.content
      .trim()
      .replace(/^[^a-zA-Z0-9가-힣\s]+|[^a-zA-Z0-9가-힣\s]+$/g, '');
  } catch (error) {
    console.error('OpenAI Next Keyword Generation Error:', error);
    return '';
  }
}

/**
 * Ollama를 이용한 이전 글 기반 연관 키워드 추출
 */
export async function generateNextKeywordWithOllama(endpoint, model, title, content) {
  try {
    let baseUrl = (endpoint || 'http://localhost:11434').trim();
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
        model: model || 'gemma4',
        prompt: `당신은 블로그 SEO 전문가입니다. 아래 제공된 블로그 글의 제목과 본문을 분석하여, 자연스럽게 이어지거나 독자가 흥미를 가질 만한 후속 연관 키워드 1개를 단어 형태로만 추천해주세요. 다른 설명 없이 오직 단어(예: 신용카드 추천)로만 응답하세요.\n\n제목: ${title}\n본문: ${content.substring(0, 500)}...`,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`);
    }
    const data = await response.json();
    return data.response.trim().replace(/^[^a-zA-Z0-9가-힣\s]+|[^a-zA-Z0-9가-힣\s]+$/g, '');
  } catch (error) {
    console.error('Ollama Next Keyword Generation Error:', error);
    return '';
  }
}

/**
 * 통합 이전 글 기반 연관 키워드 추출 함수
 */
export async function generateNextKeyword(engine, apiKeyOrConfig, title, content) {
  if (engine === 'gemini') {
    const apiKey = typeof apiKeyOrConfig === 'string' ? apiKeyOrConfig : apiKeyOrConfig.apiKey;
    return await generateNextKeywordWithGemini(apiKey, title, content);
  } else if (engine === 'ollama') {
    const { endpoint, model } = apiKeyOrConfig;
    return await generateNextKeywordWithOllama(endpoint, model, title, content);
  } else if (engine === 'openai' || engine === 'openclaw') {
    const { endpoint, apiKey, model } = apiKeyOrConfig;
    return await generateNextKeywordWithOpenAI(endpoint, apiKey, model, title, content);
  }
  return '';
}
