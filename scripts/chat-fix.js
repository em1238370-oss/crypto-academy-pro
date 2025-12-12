// Простой скрипт для исправления чата - работает всегда
console.log('Chat fix script loaded');

// Функция открытия чата
function openChat() {
    const container = document.getElementById('chatContainer');
    if (container) {
        container.classList.add('active');
        container.style.display = 'flex';
        container.style.visibility = 'visible';
        container.style.opacity = '1';
        container.style.zIndex = '10001';
        
        // Включаем поле ввода - ПРИНУДИТЕЛЬНО
        const input = document.getElementById('chatInput');
        if (input) {
            input.disabled = false;
            input.readOnly = false;
            input.removeAttribute('disabled');
            input.removeAttribute('readonly');
            input.style.cssText = 'pointer-events: auto !important; opacity: 1 !important; display: block !important; background: #0a0a0a !important; color: #cccccc !important; border: 2px solid #3a3a3a !important;';
            input.setAttribute('tabindex', '0');
            
            // Убираем все блокирующие атрибуты
            input.removeAttribute('aria-disabled');
            input.removeAttribute('aria-readonly');
            
            setTimeout(() => {
                try {
                    input.focus();
                    input.click();
                } catch(e) {
                    console.log('Focus error:', e);
                }
            }, 200);
            
            console.log('✅ Input field enabled and focused');
        } else {
            console.error('❌ chatInput not found!');
        }
    }
}

// Функция закрытия чата
function closeChat() {
    const container = document.getElementById('chatContainer');
    if (container) {
        container.classList.remove('active');
        container.style.display = 'none';
    }
}

// Принудительно фиксируем чат в правом нижнем углу ЭКРАНА (viewport)
function fixChatPosition() {
    const widget = document.getElementById('chatWidget');
    if (widget) {
        // Убеждаемся, что чат вне всех контейнеров
        const page = document.querySelector('.page');
        if (page && page.contains(widget)) {
            // Перемещаем чат в body, если он внутри .page
            document.body.appendChild(widget);
        }
        
        // Принудительно фиксируем позицию относительно viewport
        widget.style.cssText = 'position: fixed !important; bottom: 20px !important; right: 20px !important; top: auto !important; left: auto !important; z-index: 2147483647 !important; display: block !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important; margin: 0 !important; padding: 0 !important; transform: none !important;';
        
        // Проверяем, что родитель не имеет transform/position, который ломает fixed
        let parent = widget.parentElement;
        while (parent && parent !== document.body) {
            const style = window.getComputedStyle(parent);
            if (style.transform !== 'none' || style.position === 'relative' || style.position === 'absolute') {
                // Если родитель имеет transform или position, перемещаем чат в body
                if (parent !== document.body) {
                    document.body.appendChild(widget);
                    break;
                }
            }
            parent = parent.parentElement;
        }
    }
}

// Инициализация
function initChatFix() {
    console.log('Initializing chat fix...');
    
    // Фиксируем позицию чата
    fixChatPosition();
    
    // Обработчик кнопки чата
    const chatButton = document.getElementById('chatButton');
    if (chatButton) {
        // Удаляем старые обработчики
        const newButton = chatButton.cloneNode(true);
        chatButton.parentNode.replaceChild(newButton, chatButton);
        const btn = document.getElementById('chatButton');
        
        btn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            console.log('Chat button clicked');
            openChat();
        };
        
        console.log('Chat button handler added');
    }
    
    // Обработчик закрытия
    const closeBtn = document.getElementById('closeChat');
    if (closeBtn) {
        closeBtn.onclick = function(e) {
            e.preventDefault();
            closeChat();
        };
    }
    
    // Обработчик отправки сообщения
    const sendBtn = document.getElementById('sendButton');
    const chatInput = document.getElementById('chatInput');
    
    if (sendBtn && chatInput) {
        sendBtn.onclick = function(e) {
            e.preventDefault();
            const message = chatInput.value.trim();
            if (message && window.sendMessage) {
                window.sendMessage();
            } else if (message) {
                console.log('Would send:', message);
            }
        };
        
        chatInput.onkeypress = function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                const message = chatInput.value.trim();
                if (message && window.sendMessage) {
                    window.sendMessage();
                }
            }
        };
        
        console.log('Send handlers added');
    }
    
    // Быстрые вопросы
    document.querySelectorAll('.quick-question-btn').forEach(btn => {
        btn.onclick = function(e) {
            e.preventDefault();
            const question = this.getAttribute('data-question') || this.textContent.trim();
            if (question && chatInput) {
                chatInput.value = question;
                setTimeout(() => {
                    if (window.sendMessage) {
                        window.sendMessage();
                    }
                }, 100);
            }
        };
    });
}

// Запускаем сразу и после загрузки
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatFix);
} else {
    initChatFix();
}

// Повторяем каждую секунду для надёжности
setInterval(() => {
    fixChatPosition();
}, 1000);

// При скролле тоже фиксируем
window.addEventListener('scroll', fixChatPosition, { passive: true });
window.addEventListener('resize', fixChatPosition);

// Делаем функции глобальными
window.openChat = openChat;
window.closeChat = closeChat;

console.log('Chat fix initialized');

