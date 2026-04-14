// Конфигурация API
// Используем Vercel API route (работает и локально через vercel dev, и на продакшене)
const API_URL = '/api/chat';
const MODEL = 'gpt-4.1-mini';
const MAX_TOKENS = 300;
const MAX_HISTORY = 10; // Сохраняем только 10 последних сообщений

// Элементы DOM
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatMessages = document.getElementById('chatMessages');
const sendBtn = document.getElementById('sendBtn');
const chatWindow = document.querySelector('.chat-window');
let remodalApi = null;
let thanksRedirectTimer = null;
let chatWindowMinHeight = 0;
let chatWindowBaseMinHeight = 400;
let pageScrollAnimationFrameId = null;
let pageScrollTargetY = 0;
let isUserNearChatBottom = true;
let initialChatAutoScrollDone = false;
let userScrollLockUntil = 0; // Время до которого блокируем автоскролл после ручной прокрутки

// Рингтон для сообщений
const ringtone = new Audio('sounds/ringtone.mp3');
const THANKS_NAME_STORAGE_KEY = 'thanks_client_name';

function playRingtone() {
    // Останавливаем предыдущее воспроизведение чтобы не было наложений
    ringtone.pause();
    ringtone.currentTime = 0;
    ringtone.play().catch(() => {}); // catch на случай если браузер блокирует автозвук
}

// История сообщений для контекста
let messageHistory = [];
let systemPrompt = '';
let dialogTranscript = [];
let chatLeadSent = false;

function recordTranscriptEntry(role, content) {
    const text = String(content || '').trim();
    if (!text) return;
    dialogTranscript.push({
        role,
        content: text,
        timestamp: new Date().toISOString()
    });
}

function decodeChatMarkersToRu(content) {
    let text = String(content || '');
    if (!text) return '';

    const markerMap = {
        START_QUESTIONS: '[Стартовые вопросы]',
        ASK_MESSENGER: '[Выбор мессенджера]',
        NAME_INPUT: '[Запрос имени]',
        PHONE_INPUT: '[Запрос телефона]',
        REQUEST_ACCEPTED: '[Заявка принята]',
        SHOW_GALLERY: '[Показ галереи]'
    };

    text = text.replace(/\[BUTTON:\s*([^\]]+)\]/g, (_, optionsText) => {
        const options = String(optionsText || '')
            .split('|')
            .map((item) => item.trim())
            .filter(Boolean);
        if (!options.length) return '[Кнопки выбора]';
        return `[Кнопки выбора: ${options.join(', ')}]`;
    });

    text = text.replace(/\[\s*([A-Z_]+)\s*\]/g, (fullMatch, markerName) => {
        if (markerName === 'MESSAGE_DIVIDER') {
            return '';
        }
        return markerMap[markerName] || fullMatch;
    });

    return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildChatTranscriptText() {
    if (!dialogTranscript.length) return '';
    return dialogTranscript
        .map((entry) => {
            const roleLabel = entry.role === 'assistant' ? 'Менеджер' : 'Клиент';
            const preparedContent = decodeChatMarkersToRu(entry.content);
            if (!preparedContent) return '';
            return `${roleLabel}: ${preparedContent}`;
        })
        .filter(Boolean)
        .join('\n');
}

async function sendChatLeadIfReady() {
    if (chatLeadSent) return;
    const name = String(window.userName || '').trim();
    const phone = String(window.userPhone || '').trim();
    if (!name || !phone) return;

    chatLeadSent = true;

    const payload = {
        name,
        phone,
        messenger: String(window.userMessenger || '').trim(),
        page_url: window.location.href,
        section_name: 'Заявка из чата',
        section_name_text: 'Чат-бот',
        section_btn_text: 'Отправить',
        chat_history: buildChatTranscriptText()
    };

    try {
        const response = await fetch('/api/send_contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Не удалось отправить заявку из чата.');
        }
    } catch (error) {
        console.error('Ошибка отправки заявки из чата:', error);
        chatLeadSent = false;
    }
}

// Загрузка системного промпта
async function loadSystemPrompt() {
    try {
        // Загружаем оба файла параллельно
        const [sysResponse, userResponse] = await Promise.all([
            fetch('prompts/sys-prompt.txt'),
            fetch('prompts/user-prompt')
        ]);
        
        let sysPromptText = '';
        let userPromptText = '';
        
        if (sysResponse.ok) {
            sysPromptText = await sysResponse.text();
        } else {
            console.warn('Не удалось загрузить sys-prompt.txt');
        }
        
        if (userResponse.ok) {
            userPromptText = await userResponse.text();
        } else {
            console.warn('Не удалось загрузить user-prompt');
        }
        
        // Объединяем оба промпта
        if (sysPromptText || userPromptText) {
            systemPrompt = sysPromptText + (sysPromptText && userPromptText ? '\n\n' : '') + userPromptText;
            // Добавляем системное сообщение в историю
            messageHistory.push({ role: 'system', content: systemPrompt });
        } else {
            // Если оба файла не загрузились, используем дефолтный промпт
            console.warn('Не удалось загрузить промпты, используется по умолчанию');
            systemPrompt = 'Ты — Диана, виртуальный AI-консультант. Отвечай дружелюбно и профессионально.';
            messageHistory.push({ role: 'system', content: systemPrompt });
        }
    } catch (error) {
        console.error('Ошибка при загрузке промптов:', error);
        systemPrompt = 'Ты — Диана, виртуальный AI-консультант. Отвечай дружелюбно и профессионально.';
        messageHistory.push({ role: 'system', content: systemPrompt });
    }
}

// Инициализация диалога
async function initializeDialog() {
    const loadingId = addLoadingMessage();
    sendBtn.disabled = true;
    chatInput.disabled = true;
    
    try {
        // Добавляем инициализирующее сообщение пользователя
        messageHistory.push({ role: 'user', content: 'Начни диалог следуя правилам системного промпта' });
        
        // Отправляем запрос к API
        const botResponse = await sendMessageToAPI(messageHistory);
        
        // Добавляем ответ бота в чат (передаём loadingId чтобы не мигал)
        await addBotMessage(botResponse, loadingId);
        
        // Добавляем ответ в историю
        messageHistory.push({ role: 'assistant', content: botResponse });
        
    } catch (error) {
        console.error('Ошибка при инициализации диалога:', error);
        await addBotMessage('Здравствуйте! Я Диана, ваш AI-консультант. Чем могу помочь?', loadingId);
    } finally {
        sendBtn.disabled = false;
        chatInput.disabled = false;
    }
}

// Инициализация
document.addEventListener('DOMContentLoaded', async () => {
    // Все модальные окна и форма обратного звонка доступны на разных страницах
    remodalApi = initRemodals();
    initCallbackRequestForm();
    initCookieBanner();
    applyThanksClientName();

    const hasChatUI = chatForm && chatInput && chatMessages && sendBtn && chatWindow;
    if (!hasChatUI) return;
    initializeChatSizingState();
    initChatScrollBehavior();

    chatForm.addEventListener('submit', handleSubmit);

    // Загружаем системный промпт
    await loadSystemPrompt();

    // Инициализируем диалог
    await initializeDialog();
});

function cancelPageScrollAnimation() {
    if (pageScrollAnimationFrameId) {
        cancelAnimationFrame(pageScrollAnimationFrameId);
        pageScrollAnimationFrameId = null;
    }
}

function onUserScroll() {
    cancelPageScrollAnimation();
    isUserNearChatBottom = false;
    userScrollLockUntil = Date.now() + 1500; // 1.5 сек не трогаем скролл после ручной прокрутки
}

function initChatScrollBehavior() {
    if (!chatWindow) return;

    const updateFlag = () => {
        const chatBottomY = chatWindow.getBoundingClientRect().bottom + window.scrollY;
        const viewportBottomY = window.scrollY + window.innerHeight;
        const distanceFromBottom = chatBottomY - viewportBottomY;

        // Считаем, что пользователь "рядом с низом чата",
        // если до него осталось не больше 80px.
        isUserNearChatBottom = distanceFromBottom <= 80;
    };

    window.addEventListener('scroll', updateFlag, { passive: true });
    updateFlag();

    // Отменяем автоскролл при ручной прокрутке — колесо, тач, клавиши
    window.addEventListener('wheel', onUserScroll, { passive: true });
    window.addEventListener('touchmove', onUserScroll, { passive: true });
    window.addEventListener('keydown', (e) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Space'].includes(e.key)) onUserScroll();
    });
}

function initializeChatSizingState() {
    if (!chatWindow) return;
    const parsedMin = parseFloat(getComputedStyle(chatWindow).minHeight);
    chatWindowBaseMinHeight = Number.isFinite(parsedMin) ? parsedMin : 400;
    chatWindowMinHeight = chatWindowBaseMinHeight;
}

// Cookie Banner
function initCookieBanner() {
    const banner = document.getElementById('cookieBanner');
    const acceptBtn = document.getElementById('cookieAcceptBtn');
    if (!banner || !acceptBtn) return;
    
    banner.style.display = 'flex';
    
    acceptBtn.addEventListener('click', function() {
        // TODO: раскомментировать для продакшена
        // localStorage.setItem('cookiesAccepted', 'true');
        banner.style.opacity = '0';
        setTimeout(() => { banner.style.display = 'none'; }, 300);
    });
}

// Единая логика модалок с data-remodal-id/data-remodal-target
function initRemodals() {
    const remodals = Array.from(document.querySelectorAll('.remodal[data-remodal-id]'));
    if (!remodals.length) return;

    remodals.forEach((modal) => {
        modal.classList.remove('remodal-is-opened');
        modal.setAttribute('aria-hidden', 'true');
    });

    const overlay = document.createElement('div');
    overlay.className = 'remodal-overlay';
    document.body.appendChild(overlay);

    let activeModal = null;

    function closeActiveModal() {
        if (!activeModal) return;
        activeModal.classList.remove('remodal-is-opened');
        activeModal.setAttribute('aria-hidden', 'true');
        overlay.classList.remove('remodal-is-opened');
        document.body.classList.remove('remodal-is-opened');
        activeModal = null;
    }

    function openModal(targetId) {
        const modal = remodals.find((item) => item.dataset.remodalId === targetId);
        if (!modal) return;
        closeActiveModal();
        activeModal = modal;
        activeModal.classList.add('remodal-is-opened');
        activeModal.setAttribute('aria-hidden', 'false');
        overlay.classList.add('remodal-is-opened');
        document.body.classList.add('remodal-is-opened');
    }

    const outsideClickClosableIds = new Set(['privacy', 'ai-terms', 'personal-data']);
    remodals.forEach((modal) => {
        modal.addEventListener('click', (event) => {
            if (!activeModal || activeModal !== modal) return;
            if (!outsideClickClosableIds.has(modal.dataset.remodalId)) return;
            if (event.target !== modal) return;
            closeActiveModal();
        });
    });

    document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : event.target?.parentElement;
        if (!target) return;

        const openTrigger = target.closest('[data-remodal-target]');
        if (openTrigger) {
            const targetId = openTrigger.dataset.remodalTarget;
            if (remodals.some((modal) => modal.dataset.remodalId === targetId)) {
                event.preventDefault();
                openModal(targetId);
                return;
            }
        }

        const scrollTopTrigger = target.closest('[data-scroll-top]');
        if (scrollTopTrigger) {
            const modalForScroll = (activeModal && activeModal.contains(scrollTopTrigger))
                ? activeModal
                : scrollTopTrigger.closest('.remodal[data-remodal-id]');
            if (modalForScroll) {
                event.preventDefault();
                modalForScroll.scrollTo({ top: 0, behavior: 'smooth' });
                return;
            }
        }

        const closeTrigger = target.closest('[data-remodal-action="close"]');
        if (closeTrigger && activeModal && activeModal.contains(closeTrigger)) {
            event.preventDefault();
            closeActiveModal();
        }
    });

    overlay.addEventListener('click', closeActiveModal);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeActiveModal();
        }
    });

    return {
        open: openModal,
        close: closeActiveModal
    };
}

function initCallbackRequestForm() {
    const form = document.getElementById('callbackRequestForm');
    if (!form) return;

    const errorNode = document.getElementById('callbackFormError');
    const submitBtn = form.querySelector('.call-modal__submit');
    const openTriggers = document.querySelectorAll('[data-remodal-target="modal-form-call"]');
    const phoneInput = form.querySelector('input[name="phone"]');
    const agreeInput = form.querySelector('input[name="agree"]');

    const setError = (message) => {
        if (errorNode) errorNode.textContent = message || '';
    };

    const resetMessages = () => {
        setError('');
    };

    if (phoneInput) {
        phoneInput.addEventListener('input', () => {
            phoneInput.value = formatKzPhone(phoneInput.value);
        });
        phoneInput.addEventListener('focus', () => {
            if (!phoneInput.value.trim()) {
                phoneInput.value = '+7 ';
            }
        });
    }

    if (agreeInput) {
        agreeInput.addEventListener('change', () => {
            if (agreeInput.checked) {
                setError('');
            }
        });
    }

    openTriggers.forEach((trigger) => {
        trigger.addEventListener('click', () => {
            resetMessages();
            form.reset();
        });
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        resetMessages();
        let shouldUnlockSubmit = true;

        const formData = new FormData(form);
        const name = String(formData.get('name') || '').trim();
        const phone = String(formData.get('phone') || '').trim();
        const agreed = formData.get('agree') === 'on';

        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }

        if (!agreed) {
            setError('Необходимо согласиться с условиями обработки персональных данных.');
            return;
        }

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Отправляем...';
        }

        try {
            const payload = {
                name,
                phone,
                messenger: '',
                page_url: window.location.href,
                section_name: 'Форма обратного звонка',
                section_name_text: 'Закажите обратный звонок',
                section_btn_text: 'Заказать'
            };

            const response = await fetch('/api/send_contact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.success) {
                throw new Error(result.error || 'Не удалось отправить заявку. Попробуйте позже.');
            }

            shouldUnlockSubmit = false;
            if (submitBtn) {
                submitBtn.textContent = 'Заявка отправлена';
            }
            redirectToThanksPageAfterDelay(4000, name);
        } catch (error) {
            console.error('Ошибка отправки формы:', error);
        } finally {
            if (submitBtn && shouldUnlockSubmit) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Заказать';
            }
        }
    });
}

function redirectToThanksPageAfterDelay(delayMs = 4000, clientName = '') {
    if (thanksRedirectTimer) {
        clearTimeout(thanksRedirectTimer);
    }
    thanksRedirectTimer = setTimeout(() => {
        const normalizedName = String(clientName || '').trim();
        if (normalizedName) {
            sessionStorage.setItem(THANKS_NAME_STORAGE_KEY, normalizedName);
        }
        window.location.href = 'thanks.html';
    }, delayMs);
}

function applyThanksClientName() {
    const nameNode = document.getElementById('thanksClientName');
    if (!nameNode) return;

    const savedName = String(sessionStorage.getItem(THANKS_NAME_STORAGE_KEY) || '').trim();
    if (!savedName) {
        nameNode.textContent = 'УВАЖАЕМЫЙ КЛИЕНТ,';
        return;
    }

    nameNode.textContent = `${savedName.toUpperCase()},`;
}

function formatKzPhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) return '';

    let normalized = digits;
    if (normalized.startsWith('8')) normalized = `7${normalized.slice(1)}`;
    if (!normalized.startsWith('7')) normalized = `7${normalized}`;
    normalized = normalized.slice(0, 11);

    const cc = normalized.slice(0, 1);
    const p1 = normalized.slice(1, 4);
    const p2 = normalized.slice(4, 7);
    const p3 = normalized.slice(7, 9);
    const p4 = normalized.slice(9, 11);

    let formatted = `+${cc}`;
    if (p1) formatted += ` (${p1}`;
    if (p1.length === 3) formatted += ')';
    if (p2) formatted += ` ${p2}`;
    if (p3) formatted += ` ${p3}`;
    if (p4) formatted += ` ${p4}`;
    return formatted;
}

// Обработка отправки формы
async function handleSubmit(e) {
    e.preventDefault();
    
    const userMessage = chatInput.value.trim();
    if (!userMessage) return;
    
    // Очищаем поле ввода
    chatInput.value = '';
    
    // Добавляем сообщение пользователя в чат
    addUserMessage(userMessage);
    
    // Добавляем в историю
    messageHistory.push({ role: 'user', content: userMessage });
    
    // Ограничиваем историю до 10 последних сообщений (сохраняя системное сообщение)
    limitMessageHistory();
    
    // Показываем индикатор загрузки
    const loadingId = addLoadingMessage();
    
    // Блокируем кнопку отправки
    sendBtn.disabled = true;
    chatInput.disabled = true;
    
    try {
        // Отправляем запрос к API
        const botResponse = await sendMessageToAPI(messageHistory);
        
        // Добавляем ответ бота в чат (передаём loadingId чтобы не мигал)
        await addBotMessage(botResponse, loadingId);
        
        // Добавляем ответ в историю
        messageHistory.push({ role: 'assistant', content: botResponse });
        
        // Ограничиваем историю снова (сохраняя системное сообщение)
        limitMessageHistory();
        
    } catch (error) {
        console.error('Ошибка при отправке сообщения:', error);
        await addBotMessage('Извините, произошла ошибка. Попробуйте еще раз.', loadingId);
    } finally {
        // Разблокируем кнопку отправки
        sendBtn.disabled = false;
        chatInput.disabled = false;
    }
}

// Отправка сообщения к API через Vercel Serverless Function
async function sendMessageToAPI(history) {
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: MODEL,
            messages: history,
            max_tokens: MAX_TOKENS,
            temperature: 0.7
        })
    });
    
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return data.choices[0].message.content.trim();
}

// Ограничение истории сообщений
function limitMessageHistory() {
    if (messageHistory.length > MAX_HISTORY * 2 + 1) {
        const systemMsg = messageHistory[0];
        const recentMessages = messageHistory.slice(-MAX_HISTORY * 2);
        messageHistory = [systemMsg, ...recentMessages];
    }
}

// Универсальная функция для отправки запроса и обработки ответа бота
async function sendAndProcessBotResponse() {
    const loadingId = addLoadingMessage();
    sendBtn.disabled = true;
    chatInput.disabled = true;
    
    try {
        const botResponse = await sendMessageToAPI(messageHistory);
        
        // Добавляем ответ бота в чат (передаём loadingId чтобы не мигал)
        await addBotMessage(botResponse, loadingId);
        
        // Добавляем ответ в историю
        messageHistory.push({ role: 'assistant', content: botResponse });
        
        // Ограничиваем историю
        limitMessageHistory();
    } catch (error) {
        console.error('Ошибка при отправке сообщения:', error);
        await addBotMessage('Извините, произошла ошибка. Попробуйте еще раз.', loadingId);
    } finally {
        sendBtn.disabled = false;
        chatInput.disabled = false;
    }
}

// Добавление сообщения пользователя
function addUserMessage(text) {
    const messageDiv = createMessageElement('user', text);
    chatMessages.appendChild(messageDiv);
    recordTranscriptEntry('user', text);
    adjustChatWindowHeight();
    scrollToBottom();
}

// Задержка для имитации печатания (зависит от длины текста)
function getTypingDelay(text) {
    if (!text) return 1100;
    const len = text.length;
    // Минимум 1000мс, ~15мс на символ, максимум 2500мс
    return Math.min(Math.max(1000, len * 15), 2500);
}

// Задержки для разных типов элементов
const DELAY = {
    TEXT: (text) => getTypingDelay(text),   // текстовый пузырёк
    BUTTONS: 1500,                           // кнопки выбора
    MESSENGER: 1000,                         // выбор мессенджера
    INPUT_FORM: 1200,                        // формы ввода
    GALLERY: 1000,                          // галерея
    START_QUESTIONS: 1700,                  // стартовые вопросы
    ACCEPTED: 1000,                          // плашка заявки
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Показать индикатор печатания
function showTypingIndicator() {
    return addLoadingMessage();
}

// Добавление сообщения бота (с задержками)
// existingLoader — если передан, переиспользует уже показанный индикатор для первого элемента
async function addBotMessage(text, existingLoader) {
    const processedText = processBotMessage(text);
    
    // Собираем все элементы для последовательного вывода
    const queue = [];
    
    if (processedText.hasMarkers) {
        for (const part of processedText.textParts) {
            if (part.trim()) {
                queue.push({ type: 'text', content: part, delay: DELAY.TEXT(part) });
            }
        }
        for (const marker of processedText.markers) {
            const markerType = typeof marker === 'string' ? marker : marker.type;
            if (markerType === 'MESSAGE_DIVIDER') continue;
            
            let delay = 400;
            switch (markerType) {
                case 'START_QUESTIONS': delay = DELAY.START_QUESTIONS; break;
                case 'BUTTON': delay = DELAY.BUTTONS; break;
                case 'ASK_MESSENGER': delay = DELAY.MESSENGER; break;
                case 'NAME_INPUT': delay = DELAY.INPUT_FORM; break;
                case 'PHONE_INPUT': delay = DELAY.INPUT_FORM; break;
                case 'REQUEST_ACCEPTED': delay = DELAY.ACCEPTED; break;
                case 'SHOW_GALLERY': delay = DELAY.GALLERY; break;
            }
            queue.push({ type: 'marker', marker: marker, delay: delay });
        }
    } else {
        const content = processedText.textParts[0] || text;
        queue.push({ type: 'text', content: content, delay: DELAY.TEXT(content) });
    }
    
    // Для первого элемента: переиспользуем существующий индикатор или создаём новый
    let loader = existingLoader || addLoadingMessage();
    
    for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        
        // Ждём задержку, затем заменяем/убираем индикатор
        await sleep(item.delay);
        
        // Звук при появлении сообщения
        playRingtone();
        
        // Выводим элемент
        if (item.type === 'text') {
            const messageDiv = createMessageElement('bot', item.content);
            if (loader && loader.parentNode) {
                loader.replaceWith(messageDiv);
            } else {
                chatMessages.appendChild(messageDiv);
            }
        } else {
            removeLoadingMessage(loader);
            handleMarker(item.marker);
        }
        if (item.type === 'text') {
            recordTranscriptEntry('assistant', item.content);
        }
        
        adjustChatWindowHeight();
        scrollToBottom();
        
        // Если не последний — сразу показываем новый индикатор
        if (i < queue.length - 1) {
            loader = addLoadingMessage();
        }
    }
}

// Обработка сообщения бота и извлечение меток
function processBotMessage(text) {
    const markers = [];
    const textParts = [];
    let currentText = text;
    
    // Ищем метку BUTTON с опциями
    const buttonPattern = /\[BUTTON:\s*([^\]]+)\]/g;
    const buttonMatches = [];
    let buttonMatch;
    while ((buttonMatch = buttonPattern.exec(currentText)) !== null) {
        const options = buttonMatch[1].split('|').map(opt => opt.trim()).filter(opt => opt);
        markers.push({ type: 'BUTTON', options: options });
        buttonMatches.push(buttonMatch[0]);
    }
    // Удаляем метки BUTTON из текста
    buttonMatches.forEach(match => {
        currentText = currentText.replace(match, '');
    });
    
    // Ищем остальные метки
    const markerPatterns = [
        { pattern: /\[\s*START_QUESTIONS\s*\]/g, type: 'START_QUESTIONS' },
        { pattern: /\[\s*MESSAGE_DIVIDER\s*\]/g, type: 'MESSAGE_DIVIDER' },
        { pattern: /\[\s*ASK_MESSENGER\s*\]/g, type: 'ASK_MESSENGER' },
        { pattern: /\[\s*NAME_INPUT\s*\]/g, type: 'NAME_INPUT' },
        { pattern: /\[\s*PHONE_INPUT\s*\]/g, type: 'PHONE_INPUT' },
        { pattern: /\[\s*REQUEST_ACCEPTED\s*\]/g, type: 'REQUEST_ACCEPTED' },
        { pattern: /\[\s*SHOW_GALLERY\s*\]/g, type: 'SHOW_GALLERY' }
    ];
    
    // Удаляем метки из текста и сохраняем их
    markerPatterns.forEach(({ pattern, type }) => {
        if (pattern.test(currentText)) {
            markers.push({ type: type });
            currentText = currentText.replace(pattern, '');
        }
    });

    // Если в ответе есть интерактивные метки ввода/выбора (например, [ASK_MESSENGER]),
    // то кнопки [BUTTON:] в этом же ответе считаем шумом и не показываем,
    // иначе получается "двойной" выбор.
    const hasInputLikeMarker = markers.some(m => {
        const t = (typeof m === 'string' ? m : m.type);
        return t === 'ASK_MESSENGER' || t === 'PHONE_INPUT' || t === 'NAME_INPUT';
    });
    if (hasInputLikeMarker) {
        for (let i = markers.length - 1; i >= 0; i--) {
            const t = (typeof markers[i] === 'string' ? markers[i] : markers[i].type);
            if (t === 'BUTTON') markers.splice(i, 1);
        }
    }
    
    // Разделяем текст по меткам MESSAGE_DIVIDER (если они были)
    const hasMessageDivider = markers.some(m => (typeof m === 'string' ? m : m.type) === 'MESSAGE_DIVIDER');
    if (hasMessageDivider) {
        // Разделяем на абзацы или предложения
        const parts = currentText.split(/\n\n+/).filter(p => p.trim());
        if (parts.length > 0) {
            textParts.push(...parts);
        } else {
            textParts.push(currentText);
        }
    } else {
        textParts.push(currentText.trim());
    }
    
    return {
        textParts: textParts.filter(p => p.trim()),
        markers: markers,
        hasMarkers: markers.length > 0
    };
}

// Обработка меток
function handleMarker(marker) {
    const markerType = typeof marker === 'string' ? marker : marker.type;
    
    switch (markerType) {
        case 'START_QUESTIONS':
            showStartQuestions();
            break;
        case 'BUTTON':
            showButtons(marker.options);
            break;
        case 'ASK_MESSENGER':
            showMessengerOptions();
            break;
        case 'NAME_INPUT':
            showNameInputForm();
            break;
        case 'PHONE_INPUT':
            showPhoneInputForm();
            break;
        case 'REQUEST_ACCEPTED':
            showRequestAccepted();
            break;
        case 'SHOW_GALLERY':
            showGallery();
            break;
    }
}

// Показать стартовые вопросы
function showStartQuestions() {
    const questionsContainer = document.createElement('div');
    questionsContainer.className = 'start-questions-container';
    
    const questions = [
        'Какая техника есть в наличии?',
        'Интересует конкретная техника',
        'Расскажите об условиях лизинга или рассрочки',
        'Какие гарантии вы даете на спецтехнику?',
        'Хочу узнать о технике XCMG, чем она лучше аналогов?',
        'Хочу задать свой вопрос'
    ];
    
    questions.forEach((question, index) => {
        const questionBtn = document.createElement('button');
        questionBtn.className = 'start-question-btn';
        questionBtn.textContent = question;
        questionBtn.addEventListener('click', () => {
            // Добавляем выбранный вопрос как сообщение пользователя
            addUserMessage(question);
            messageHistory.push({ role: 'user', content: question });
            
            // Удаляем контейнер с вопросами и текстом
            questionsContainer.remove();
            
            // Отправляем запрос к API
            handleQuestionSelection();
        });
        questionsContainer.appendChild(questionBtn);
    });
    
    
    chatMessages.appendChild(questionsContainer);
    adjustChatWindowHeight();
    scrollToBottom();
}

// Обработка выбранного вопроса
async function handleQuestionSelection() {
    await sendAndProcessBotResponse();
}

// Показать кнопки с опциями
function showButtons(options) {
    if (!options || options.length === 0) return;
    
    const buttonsContainer = document.createElement('div');
    buttonsContainer.className = 'buttons-container';
    
    options.forEach((option) => {
        const button = document.createElement('button');
        button.className = 'option-button';
        button.textContent = option;
        button.addEventListener('click', () => {
            // Добавляем выбранную опцию как сообщение пользователя
            addUserMessage(option);
            messageHistory.push({ role: 'user', content: option });
            
            // Удаляем контейнер с кнопками
            buttonsContainer.remove();
            
            // Отправляем запрос к API
            handleButtonSelection();
        });
        buttonsContainer.appendChild(button);
    });
    
    chatMessages.appendChild(buttonsContainer);
    adjustChatWindowHeight();
    scrollToBottom();
}

// Обработка выбранной опции из кнопок
async function handleButtonSelection() {
    await sendAndProcessBotResponse();
}

// Показать варианты мессенджеров
function showMessengerOptions() {
    const messengersContainer = document.createElement('div');
    messengersContainer.className = 'messengers-container';
    
    const messengers = ['WhatsApp', 'Telegram'];
    
    messengers.forEach((messenger) => {
        const button = document.createElement('button');
        button.className = 'messenger-button';
        button.textContent = messenger;
        button.addEventListener('click', () => {
            // Добавляем выбранный мессенджер как сообщение пользователя
            addUserMessage(messenger);
            messageHistory.push({ role: 'user', content: messenger });
            window.userMessenger = messenger;
            
            // Удаляем контейнер с кнопками
            messengersContainer.remove();
            
            // Отправляем запрос к API
            handleMessengerSelection();
        });
        messengersContainer.appendChild(button);
    });
    
    chatMessages.appendChild(messengersContainer);
    adjustChatWindowHeight();
    scrollToBottom();
}

// Обработка выбранного мессенджера
async function handleMessengerSelection() {
    await sendAndProcessBotResponse();
}

// Показать форму ввода имени
function showNameInputForm() {
    const formContainer = document.createElement('div');
    formContainer.className = 'input-form-container';
    
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'name-input';
    input.placeholder = 'Введите ваше имя';
    
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'form-submit-btn';
    submitBtn.textContent = 'Отправить';
    
    submitBtn.addEventListener('click', () => {
        const name = input.value.trim();
        if (name) {
            // Добавляем имя как сообщение пользователя
            addUserMessage(`Имя: ${name}`);
            messageHistory.push({ role: 'user', content: `Имя: ${name}` });
            
            // Сохраняем имя для дальнейшего использования
            window.userName = name;
            
            formContainer.remove();
            
            // Продолжаем диалог
            continueAfterNameInput();
        }
    });
    
    formContainer.appendChild(input);
    formContainer.appendChild(submitBtn);
    chatMessages.appendChild(formContainer);
    adjustChatWindowHeight();
    scrollToBottom();
}

// Продолжение после ввода имени
async function continueAfterNameInput() {
    await sendChatLeadIfReady();
    await sendAndProcessBotResponse();
}

// Показать форму ввода телефона
function showPhoneInputForm() {
    const formContainer = document.createElement('div');
    formContainer.className = 'input-form-container';
    formContainer.classList.add('phone-capture-form');

    const phoneRow = document.createElement('div');
    phoneRow.className = 'phone-capture-form__row';
    
    const input = document.createElement('input');
    input.type = 'tel';
    input.className = 'phone-input';
    input.placeholder = 'Ваш телефон';
    input.autocomplete = 'tel';

    input.addEventListener('input', () => {
        input.value = formatKzPhone(input.value);
    });
    input.addEventListener('focus', () => {
        if (!input.value.trim()) {
            input.value = '+7 ';
        }
    });
    
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'form-submit-btn';
    submitBtn.textContent = 'Отправить';

    const agreeLabel = document.createElement('label');
    agreeLabel.className = 'chat-consent';

    const agreeCheckbox = document.createElement('input');
    agreeCheckbox.className = 'chat-consent__checkbox';
    agreeCheckbox.type = 'checkbox';
    agreeCheckbox.name = 'agree';

    const agreeUi = document.createElement('span');
    agreeUi.className = 'chat-consent__checkbox-ui';
    agreeUi.setAttribute('aria-hidden', 'true');

    const agreeText = document.createElement('span');
    agreeText.className = 'chat-consent__text';
    agreeText.innerHTML = `
        Я даю <a href="#" data-remodal-target="personal-data">Согласие на обработку моих персональных данных</a>
        и принимаю <a href="#" data-remodal-target="privacy">Политику конфиденциальности</a>
    `;

    agreeLabel.appendChild(agreeCheckbox);
    agreeLabel.appendChild(agreeUi);
    agreeLabel.appendChild(agreeText);

    const errorNode = document.createElement('p');
    errorNode.className = 'chat-consent__error';
    errorNode.setAttribute('role', 'alert');
    errorNode.setAttribute('aria-live', 'polite');

    const setError = (message) => {
        errorNode.textContent = message || '';
    };

    agreeCheckbox.addEventListener('change', () => {
        if (agreeCheckbox.checked) {
            setError('');
        }
    });
    
    submitBtn.addEventListener('click', () => {
        const phone = input.value.trim();
        const agreed = agreeCheckbox.checked;

        if (!agreed) {
            setError('Необходимо согласиться с условиями обработки персональных данных.');
            return;
        }
        setError('');
        
        if (phone) {
            addUserMessage(`Телефон: ${phone}`);
            messageHistory.push({ role: 'user', content: `Телефон: ${phone}` });
            window.userPhone = phone;
            
            formContainer.remove();
            continueAfterPhoneInput();
        }
    });
    
    phoneRow.appendChild(input);
    phoneRow.appendChild(submitBtn);

    formContainer.appendChild(phoneRow);
    formContainer.appendChild(agreeLabel);
    formContainer.appendChild(errorNode);
    chatMessages.appendChild(formContainer);
    adjustChatWindowHeight();
    scrollToBottom();
}

// Продолжение после ввода телефона
async function continueAfterPhoneInput() {
    await sendChatLeadIfReady();
    await sendAndProcessBotResponse();
}

// Показать плашку о принятии заявки
function showRequestAccepted() {
    const acceptedDiv = document.createElement('div');
    acceptedDiv.className = 'request-accepted';
    acceptedDiv.innerHTML = `
        <div class="accepted-content">
            <strong>✓ Заявка принята!</strong>
            <p>Ваша заявка успешно отправлена. Мы свяжемся с вами в ближайшее время.</p>
        </div>
    `;
    chatMessages.appendChild(acceptedDiv);
    adjustChatWindowHeight();
    scrollToBottom();
    redirectToThanksPageAfterDelay(4000, window.userName);
}

// Показать галерею примеров работ
let gallerySwiperCount = 0;

function showGallery() {
    gallerySwiperCount++;
    const uniqueClass = `gallery-swiper-${gallerySwiperCount}`;

    const galleryContainer = document.createElement('div');
    galleryContainer.className = 'gallery-container';

    const images = ['images/ex1.png', 'images/ex2.png', 'images/ex3.png'];

    galleryContainer.innerHTML = `
        <div class="swiper ${uniqueClass} gallery-swiper">
            <div class="swiper-wrapper">
                ${images.map((src, i) => `
                    <div class="swiper-slide">
                        <img src="${src}" alt="Пример работы ${i + 1}">
                    </div>
                `).join('')}
            </div>
            <div class="swiper-button-prev"></div>
            <div class="swiper-button-next"></div>
        </div>
    `;

    chatMessages.appendChild(galleryContainer);
    adjustChatWindowHeight();
    scrollToBottom();

    // Инициализируем Swiper после вставки в DOM
    setTimeout(() => {
        new Swiper(`.${uniqueClass}`, {
            slidesPerView: 1,
            spaceBetween: 10,
            loop: true,
            navigation: {
                nextEl: `.${uniqueClass} .swiper-button-next`,
                prevEl: `.${uniqueClass} .swiper-button-prev`,
            },
            breakpoints: {
                768: {
                    slidesPerView: 2,
                    spaceBetween: 12,
                },
                1024: {
                    slidesPerView: 3,
                    spaceBetween: 15,
                }
            }
        });
        adjustChatWindowHeight();
        scrollToBottom();
    }, 50);
}

// Создание элемента сообщения
function createMessageElement(type, text) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message message-${type}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.textContent = text;
    
    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    timeDiv.textContent = getCurrentTime();
    
    contentDiv.appendChild(timeDiv);
    messageDiv.appendChild(contentDiv);
    
    return messageDiv;
}

// Добавление индикатора загрузки (возвращает сам элемент)
function addLoadingMessage() {
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'message message-bot loading-indicator';
    
    const loadingContent = document.createElement('div');
    loadingContent.className = 'loading';
    
    const dots = document.createElement('div');
    dots.className = 'loading-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    
    loadingContent.appendChild(dots);
    loadingDiv.appendChild(loadingContent);
    chatMessages.appendChild(loadingDiv);
    
    scrollToBottom();
    
    return loadingDiv;
}

// Удаление индикатора загрузки
function removeLoadingMessage(el) {
    if (el && el.parentNode) {
        el.remove();
    }
}

// Получение текущего времени
function getCurrentTime() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

// Прокрутка вниз
function scrollToBottom(force = false) {
    // Первый автоскролл — всегда выполняем,
    // чтобы при открытии страницы показать окно чата.
    if (!initialChatAutoScrollDone) {
        initialChatAutoScrollDone = true;
        scrollPageToChatBottom();
        return;
    }

    // Не мешаем пользователю: если он недавно прокручивал вручную — не трогаем скролл
    if (Date.now() < userScrollLockUntil) return;

    // Дальше скроллим только если пользователь сам "у низа"
    // или явно передан флаг force.
    if (!isUserNearChatBottom && !force) return;
    scrollPageToChatBottom();
}

function scrollPageToChatBottom() {
    if (!chatWindow) return;
    if (Date.now() < userScrollLockUntil) return;

    const chatBottomY = chatWindow.getBoundingClientRect().bottom + window.scrollY;
    const desiredY = Math.max(0, chatBottomY - window.innerHeight + 16);
    pageScrollTargetY = desiredY;

    if (pageScrollAnimationFrameId) return;

    const step = () => {
        if (Date.now() < userScrollLockUntil) {
            pageScrollAnimationFrameId = null;
            return;
        }
        const current = window.scrollY;
        const distance = pageScrollTargetY - current;

        if (Math.abs(distance) < 0.8) {
            window.scrollTo(0, pageScrollTargetY);
            pageScrollAnimationFrameId = null;
            return;
        }

        const isLongScroll = Math.abs(distance) > 520;
        const factor = isLongScroll ? 0.16 : 0.12;
        const minStep = isLongScroll ? 1.2 : 0.6;
        const rawDelta = distance * factor;
        const delta = Math.sign(distance) * Math.max(minStep, Math.abs(rawDelta));
        const next = current + delta;

        window.scrollTo(0, distance > 0
            ? Math.min(next, pageScrollTargetY)
            : Math.max(next, pageScrollTargetY));

        pageScrollAnimationFrameId = requestAnimationFrame(step);
    };

    pageScrollAnimationFrameId = requestAnimationFrame(step);
}

// Автоматическое увеличение высоты окна чата
function adjustChatWindowHeight() {
    if (!chatWindow || !chatMessages) return;
    const inputArea = document.querySelector('.chat-input-area');
    if (!inputArea) return;

    if (!chatWindowMinHeight) {
        initializeChatSizingState();
    }

    const messagesHeight = chatMessages.scrollHeight;
    const inputAreaHeight = inputArea.offsetHeight;
    const requiredHeight = Math.ceil(messagesHeight + inputAreaHeight);
    const targetHeight = Math.max(requiredHeight, chatWindowBaseMinHeight);

    // Увеличиваем окно только вверх, чтобы не было "скачка" при замене лоадера на сообщение.
    if (targetHeight > chatWindowMinHeight) {
        chatWindowMinHeight = targetHeight;
        chatWindow.style.height = 'auto';
        chatWindow.style.minHeight = `${chatWindowMinHeight}px`;
    }

    scrollToBottom();
}

