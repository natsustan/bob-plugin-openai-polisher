//@ts-check

var lang = require("./lang.js");
var ChatGPTModels = [
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0301",
    "gpt-4",
    "gpt-4-0314",
    "gpt-4-32k",
    "gpt-4-32k-0314",
];

/**
 * @param {string}  url
 * @returns {string} 
*/
function ensureHttpsAndNoTrailingSlash(url) {
    const hasProtocol = /^[a-z]+:\/\//i.test(url);
    const modifiedUrl = hasProtocol ? url : 'https://' + url;

    return modifiedUrl.endsWith('/') ? modifiedUrl.slice(0, -1) : modifiedUrl;
}

/**
 * @param {boolean} isAzureServiceProvider - Indicates if the service provider is Azure.
 * @param {string} apiKey - The authentication API key.
 * @returns {{
*   "Content-Type": string;
*   "api-key"?: string;
*   "Authorization"?: string;
* }} The header object.
*/
function buildHeader(isAzureServiceProvider, apiKey) {
    return {
        "Content-Type": "application/json",
        [isAzureServiceProvider ? "api-key" : "Authorization"]: isAzureServiceProvider ? apiKey : `Bearer ${apiKey}`
    };
}

/**
 * @param {string} basePrompt
 * @param {"simplicity" | "detailed"} polishingMode
 * @param {Bob.TranslateQuery} query
 * @returns {string}
*/
function generateSystemPrompt(basePrompt, polishingMode, query) {
    let systemPrompt = basePrompt || "Revise the following sentences to make them more clear, concise, and coherent.";

    const isDetailedPolishingMode = polishingMode === "detailed";
    if (isDetailedPolishingMode) {
        systemPrompt = `${systemPrompt}. Please note that you need to list the changes and briefly explain why`;
    }
    switch (query.detectFrom) {
        case "zh-Hant":
            systemPrompt = "潤色此句";
            if (isDetailedPolishingMode) {
                systemPrompt = `${systemPrompt}。請列出修改項目，並簡述修改原因`;
            }
            break;
        case "zh-Hans":
            systemPrompt = "润色此句";
            if (isDetailedPolishingMode) {
                systemPrompt = `${systemPrompt}。请注意要列出更改以及简要解释一下为什么这么修改`;
            }
            break;
        case "ja":
            systemPrompt = "この文章を装飾する";
            if (isDetailedPolishingMode) {
                systemPrompt = `${systemPrompt}。変更点をリストアップし、なぜそのように変更したかを簡単に説明することに注意してください`;
            }
            break;
        case "ru":
            systemPrompt =
                "Переформулируйте следующие предложения, чтобы они стали более ясными, краткими и связными";
            if (isDetailedPolishingMode) {
                systemPrompt = `${systemPrompt}. Пожалуйста, обратите внимание на необходимость перечисления изменений и краткого объяснения причин таких изменений`;
            }
            break;
        case "wyw":
            systemPrompt = "润色此句古文";
            if (isDetailedPolishingMode) {
                systemPrompt = `${systemPrompt}。请注意要列出更改以及简要解释一下为什么这么修改`;
            }
            break;
        case "yue":
            systemPrompt = "潤色呢句粵語";
            if (isDetailedPolishingMode) {
                systemPrompt = `${systemPrompt}。記住要列出修改嘅內容同簡單解釋下點解要做呢啲更改`;
            }
            break;
    }

    return systemPrompt;
}

/**
 * @param {typeof ChatGPTModels[number]} model
 * @param {boolean} isChatGPTModel
 * @param {Bob.TranslateQuery} query
 * @returns {{ 
 *  model: typeof ChatGPTModels[number];
 *  temperature: number;
 *  max_tokens: number;
 *  top_p: number;
 *  frequency_penalty: number;
 *  presence_penalty: number;
 *  messages?: {
 *    role: "system" | "user";
 *    content: string;
 *  }[];
 *  prompt?: string;
 * }}
*/
function buildRequestBody(model, isChatGPTModel, query) {
    const { customSystemPrompt, customUserPrompt, polishingMode } = $option;

    const systemPrompt = generateSystemPrompt(customSystemPrompt, polishingMode, query);
    const userPrompt = customUserPrompt ? `${customUserPrompt}:\n\n"${query.text}"` : query.text;

    const standardBody = {
        model,
        temperature: 0,
        max_tokens: 1000,
        top_p: 1,
        frequency_penalty: 1,
        presence_penalty: 1,
    };

    if (isChatGPTModel) {
        return {
            ...standardBody,
            messages: [
                {
                    role: "system",
                    content: systemPrompt,
                },
                {
                    role: "user",
                    content: userPrompt,
                },
            ],
        };
    }
    return {
        ...standardBody,
        prompt: `${systemPrompt}\n\n${userPrompt}`,
    };
}

/**
 * @param {Bob.Completion} completion
 * @param {Bob.HttpResponse} result
 * @returns {void}
*/
function handleError(completion, result) {
    const { statusCode } = result.response;
    const reason = (statusCode >= 400 && statusCode < 500) ? "param" : "api";
    completion({
        error: {
            type: reason,
            message: `接口响应错误 - ${result.data.error.message}`,
            addtion: JSON.stringify(result),
        },
    });
}

/**
 * @param {Bob.Completion} completion
 * @param {boolean} isChatGPTModel
 * @param {Bob.TranslateQuery} query
 * @param {Bob.HttpResponse} result
 * @returns {void}
*/
function handleResponse(completion, isChatGPTModel, query, result) {
    const { choices } = result.data;

    if (!choices || choices.length === 0) {
        completion({
            error: {
                type: "api",
                message: "接口未返回结果",
                addtion: JSON.stringify(result),
            },
        });
        return;
    }

    let targetText = (isChatGPTModel ? choices[0].message.content : choices[0].text).trim();

    completion({
        result: {
            from: query.detectFrom,
            to: query.detectTo,
            toParagraphs: targetText.split("\n"),
        },
    });
}

/**
 * @type {Bob.Translate}
 */
function translate(query, completion) {
    if (!lang.langMap.get(query.detectTo)) {
        completion({
            error: {
                type: "unsupportLanguage",
                message: "不支持该语种",
                addtion: "不支持该语种",
            },
        });
    }

    const { model, apiKeys, apiUrl, deploymentName } = $option;

    if (!apiKeys) {
        completion({
            error: {
                type: "secretKey",
                message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
                addtion: "请在插件配置中填写 API Keys",
            },
        });
    }
    const trimmedApiKeys = apiKeys.endsWith(",") ? apiKeys.slice(0, -1) : apiKeys;
    const apiKeySelection = trimmedApiKeys.split(",").map(key => key.trim());
    const apiKey = apiKeySelection[Math.floor(Math.random() * apiKeySelection.length)];

    const modifiedApiUrl = ensureHttpsAndNoTrailingSlash(apiUrl || "https://api.openai.com");
    
    const isChatGPTModel = ChatGPTModels.includes(model);
    const isAzureServiceProvider = modifiedApiUrl.includes("openai.azure.com");
    let apiUrlPath = isChatGPTModel ? "/v1/chat/completions" : "/v1/completions";
    
    if (isAzureServiceProvider) {
        if (deploymentName) {
            apiUrlPath = `/openai/deployments/${deploymentName}`;
            apiUrlPath += isChatGPTModel ? "/chat/completions?api-version=2023-03-15-preview" : "/completions?api-version=2022-12-01";
        } else {
            completion({
                error: {
                    type: "secretKey",
                    message: "配置错误 - 未填写 Deployment Name",
                    addtion: "请在插件配置中填写 Deployment Name",
                },
            });
        } 
    }

    const header = buildHeader(isAzureServiceProvider, apiKey);
    const body = buildRequestBody(model, isChatGPTModel, query);

    (async () => {
        const result = await $http.request({
            method: "POST",
            url: modifiedApiUrl + apiUrlPath,
            header,
            body,
        });

        if (result.error) {
            handleError(completion, result);
        } else {
            handleResponse(completion, isChatGPTModel, query, result);
        }
    })().catch((err) => {
        completion({
            error: {
                type: err._type || "unknown",
                message: err._message || "未知错误",
                addtion: err._addition,
            },
        });
    });
}

function supportLanguages() {
    return lang.supportLanguages.map(([standardLang]) => standardLang);
}

exports.supportLanguages = supportLanguages;
exports.translate = translate;