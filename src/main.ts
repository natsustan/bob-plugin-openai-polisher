import type {
  HttpResponse,
  PluginValidate,
  ServiceError,
  TextTranslate,
  TextTranslateQuery
} from "@bob-translate/types";
import { DEFAULT_PROMPT, languageMapping } from "./const";
import { langMap, supportLanguageList } from "./lang";
import type {
  ChatCompletion,
  ModelList,
  PolishingMode,
} from "./types";
import {
  buildHeader,
  ensureHttpsAndNoTrailingSlash,
  getApiKey,
  handleGeneralError,
  handleValidateError,
  replacePromptKeywords
} from "./utils";

const pluginTimeoutInterval = () => 60;

const pluginValidate: PluginValidate = (completion) => {
  const { apiKeys, apiUrl, deploymentName } = $option;
  if (!apiKeys) {
    handleValidateError(completion, {
      type: "secretKey",
      message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
      addition: "请在插件配置中填写正确的 API Keys",
      troubleshootingLink: "https://bobtranslate.com/service/translate/openai.html"
    });
    return;
  }

  const apiKey = getApiKey(apiKeys);
  const baseUrl = ensureHttpsAndNoTrailingSlash(apiUrl || "https://api.openai.com");
  let apiUrlPath = baseUrl.includes("gateway.ai.cloudflare.com") ? "/models" : "/v1/models";

  const isAzureServiceProvider = apiUrl.includes("openai.azure.com");
  if (isAzureServiceProvider) {
    if (!deploymentName) {
      handleValidateError(completion, {
        type: "secretKey",
        message: "配置错误 - 未填写 Deployment Name",
        addition: "请在插件配置中填写 Deployment Name",
        troubleshootingLink: "https://bobtranslate.com/service/translate/azureopenai.html"
      });
      return;
    }
    apiUrlPath = `/openai/deployments/${deploymentName}/chat/completions?api-version=2023-05-15`;
  }

  const header = buildHeader(isAzureServiceProvider, apiKey);
  (async () => {
    if (isAzureServiceProvider) {
      $http.request({
        method: "POST",
        url: baseUrl + apiUrlPath,
        header: header,
        body: {
          "messages": [{
            "content": "You are a helpful assistant.",
            "role": "system",
          }, {
            "content": "Test connection.",
            "role": "user",
          }],
          max_tokens: 5
        },
        handler: function (resp) {
          const data = resp.data as {
            error: string;
          }
          if (data.error) {
            const { statusCode } = resp.response;
            const reason = (statusCode >= 400 && statusCode < 500) ? "param" : "api";
            handleValidateError(completion, {
              type: reason,
              message: data.error,
              troubleshootingLink: "https://bobtranslate.com/service/translate/azureopenai.html"
            });
            return;
          }
          if ((resp.data as ChatCompletion).choices.length > 0) {
            completion({
              result: true,
            })
          }
        }
      });
    } else {
      $http.request({
        method: "GET",
        url: baseUrl + apiUrlPath,
        header: header,
        handler: function (resp) {
          const data = resp.data as {
            error: string;
          }
          if (data.error) {
            const { statusCode } = resp.response;
            const reason = (statusCode >= 400 && statusCode < 500) ? "param" : "api";
            handleValidateError(completion, {
              type: reason,
              message: data.error,
              troubleshootingLink: "https://bobtranslate.com/service/translate/openai.html"
            });
            return;
          }
          const modelList = resp.data as ModelList;
          if (modelList.data?.length > 0) {
            completion({
              result: true,
            })
          }
        }
      });
    }
  })().catch((error) => {
    handleValidateError(completion, error);
  });
}

function supportLanguages() {
  return supportLanguageList.map(([standardLang]) => standardLang);
}

const isServiceError = (error: unknown): error is ServiceError => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as ServiceError).message === 'string'
  );
}

const generateSystemPrompt = (
  basePrompt: string | null,
  polishingMode: PolishingMode,
  query: TextTranslateQuery
): string => {
  const isDetailedPolishingMode = polishingMode === "detailed";

  const promptInfo = languageMapping[query.detectFrom] || {
    prompt: DEFAULT_PROMPT.simplicity,
    detailed: DEFAULT_PROMPT.detailed,
  };

  let systemPrompt = basePrompt || promptInfo.prompt;
  if (isDetailedPolishingMode) {
    systemPrompt += promptInfo.detailed;
  }

  return systemPrompt;
}

const buildRequestBody = (
  model: string,
  query: TextTranslateQuery
) => {
  const { customSystemPrompt, customUserPrompt, polishingMode } = $option;

  const systemPrompt = generateSystemPrompt(
    replacePromptKeywords(customSystemPrompt, query),
    polishingMode as PolishingMode,
    query
  );

  const userPrompt = customUserPrompt
    ? `${replacePromptKeywords(customUserPrompt, query)}:\n\n"${query.text}"`
    : query.text;

  const standardBody = {
    model: model,
    temperature: 0.2,
    max_tokens: 1000,
    top_p: 1,
    frequency_penalty: 1,
    presence_penalty: 1,
  };

  return {
    ...standardBody,
    model: model,
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

const handleStreamResponse = (
  query: TextTranslateQuery,
  targetText: string,
  textFromResponse: string
) => {
  if (textFromResponse !== '[DONE]') {
    try {
      const dataObj = JSON.parse(textFromResponse);
      // https://github.com/openai/openai-node/blob/master/src/resources/chat/completions#L190
      const { choices } = dataObj;
      const delta = choices[0]?.delta?.content;
      if (delta) {
        targetText += delta;
        query.onStream({
          result: {
            from: query.detectFrom,
            to: query.detectTo,
            toParagraphs: [targetText],
          },
        });
      }
    } catch (error) {
      if (isServiceError(error)) {
        handleGeneralError(query, {
          type: error.type || 'param',
          message: error.message || 'Failed to parse JSON',
          addition: error.addition,
        });
      } else {
        handleGeneralError(query, {
          type: 'param',
          message: 'An unknown error occurred',
        });
      }
    }
  }
  return targetText;
}

const handleGeneralResponse = (query: TextTranslateQuery, result: HttpResponse) => {
  const { choices } = result.data as ChatCompletion;

  if (!choices || choices.length === 0) {
    handleGeneralError(query, {
      type: "api",
      message: "接口未返回结果",
      addition: JSON.stringify(result),
    });
    return;
  }

  let targetText = choices[0].message.content?.trim();

  // 使用正则表达式删除字符串开头和结尾的特殊字符
  targetText = targetText?.replace(/^(『|「|"|“)|(』|」|"|”)$/g, "");

  // 判断并删除字符串末尾的 `" =>`
  if (targetText?.endsWith('" =>')) {
    targetText = targetText.slice(0, -4);
  }

  query.onCompletion({
    result: {
      from: query.detectFrom,
      to: query.detectTo,
      toParagraphs: targetText!.split("\n"),
    },
  });
}

const translate: TextTranslate = (query) => {
  if (!langMap.get(query.detectTo)) {
    handleGeneralError(query, {
      type: "unsupportedLanguage",
      message: "不支持该语种",
      addition: "不支持该语种",
    });
  }

  const {
    apiKeys,
    apiUrl,
    apiVersion,
    customModel,
    deploymentName,
    model,
    stream,
  } = $option;

  const isCustomModelRequired = model === "custom";
  if (isCustomModelRequired && !customModel) {
    handleGeneralError(query, {
      type: "param",
      message: "配置错误 - 请确保您在插件配置中填入了正确的自定义模型名称",
      addition: "请在插件配置中填写自定义模型名称",
    });
  }

  if (!apiKeys) {
    handleGeneralError(query, {
      type: "secretKey",
      message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
      addition: "请在插件配置中填写 API Keys",
    });
  }

  const modelValue = isCustomModelRequired ? customModel : model;

  const apiKey = getApiKey($option.apiKeys);

  const baseUrl = ensureHttpsAndNoTrailingSlash(apiUrl || "https://api.openai.com");
  let apiUrlPath = baseUrl.includes("gateway.ai.cloudflare.com") ? "/chat/completions" : "/v1/chat/completions";
  const apiVersionQuery = apiVersion ? `?api-version=${apiVersion}` : "?api-version=2023-03-15-preview";

  const isAzureServiceProvider = baseUrl.includes("openai.azure.com");
  if (isAzureServiceProvider) {
    if (deploymentName) {
      apiUrlPath = `/openai/deployments/${deploymentName}/chat/completions${apiVersionQuery}`;
    } else {
      handleGeneralError(query, {
        type: "secretKey",
        message: "配置错误 - 未填写 Deployment Name",
        addition: "请在插件配置中填写 Deployment Name",
        troubleshootingLink: "https://bobtranslate.com/service/translate/azureopenai.html"
      });
    }
  }

  const header = buildHeader(isAzureServiceProvider, apiKey);
  const body = buildRequestBody(modelValue, query);

  let targetText = ""; // 初始化拼接结果变量
  let buffer = ""; // 新增 buffer 变量
  (async () => {
    if (Number(stream)) {
      await $http.streamRequest({
        method: "POST",
        url: baseUrl + apiUrlPath,
        header,
        body: {
          ...body,
          stream: true,
        },
        cancelSignal: query.cancelSignal,
        streamHandler: (streamData) => {
          if (streamData.text?.includes("Invalid token")) {
            handleGeneralError(query, {
              type: "secretKey",
              message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
              addition: "请在插件配置中填写正确的 API Keys",
              troubleshootingLink: "https://bobtranslate.com/service/translate/openai.html"
            });
          } else if (streamData.text !== undefined) {
            // 将新的数据添加到缓冲变量中
            buffer += streamData.text;
            // 检查缓冲变量是否包含一个完整的消息
            while (true) {
              const match = buffer.match(/data: (.*?})\n/);
              if (match) {
                // 如果是一个完整的消息，处理它并从缓冲变量中移除
                const textFromResponse = match[1].trim();
                targetText = handleStreamResponse(query, targetText, textFromResponse);
                buffer = buffer.slice(match[0].length);
              } else {
                // 如果没有完整的消息，等待更多的数据
                break;
              }
            }
          }
        },
        handler: (result) => {
          if (result.response.statusCode >= 400) {
            handleGeneralError(query, result);
          } else {
            query.onCompletion({
              result: {
                from: query.detectFrom,
                to: query.detectTo,
                toParagraphs: [targetText],
              },
            });
          }
        }
      });
    } else {
      const result = await $http.request({
        method: "POST",
        url: baseUrl + apiUrlPath,
        header,
        body,
      });

      if (result.error) {
        handleGeneralError(query, result);
      } else {
        handleGeneralResponse(query, result);
      }
    }
  })().catch((error) => {
    handleGeneralError(query, error);
  });
}

export {
  pluginTimeoutInterval,
  pluginValidate,
  supportLanguages,
  translate,
}