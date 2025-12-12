// ПРОСТОЙ И НАДЁЖНЫЙ СКРИПТ ДЛЯ ЧАТА - РАБОТАЕТ ВСЕГДА
console.log('=== CHAT SIMPLE FIX LOADED ===');

(function() {
    'use strict';
    
    // 1. ФИКСИРУЕМ ЧАТ В ПРАВОМ НИЖНЕМ УГЛУ ЭКРАНА
    function forceChatPosition() {
        const widget = document.getElementById('chatWidget');
        if (!widget) {
            console.error('chatWidget not found');
            return;
        }
        
        // Перемещаем чат в body если он внутри .page
        const page = document.querySelector('.page');
        if (page && page.contains(widget) && widget.parentElement !== document.body) {
            console.log('Moving chat widget to body');
            document.body.appendChild(widget);
        }
        
        // Принудительно фиксируем позицию
        widget.style.cssText = `
            position: fixed !important;
            bottom: 20px !important;
            right: 20px !important;
            top: auto !important;
            left: auto !important;
            z-index: 2147483647 !important;
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
            pointer-events: auto !important;
            margin: 0 !important;
            padding: 0 !important;
            transform: none !important;
        `;
        
        // Проверяем родительские элементы
        let parent = widget.parentElement;
        while (parent && parent !== document.body) {
            const style = window.getComputedStyle(parent);
            if (style.transform !== 'none' || 
                (style.position === 'relative' && parent.classList.contains('page'))) {
                if (parent !== document.body) {
                    document.body.appendChild(widget);
                    console.log('Moved widget to body due to parent transform/position');
                    break;
                }
            }
            parent = parent.parentElement;
        }
    }
    
    // 2. ОТКРЫТИЕ ЧАТА
    function openChat() {
        console.log('Opening chat...');
        const container = document.getElementById('chatContainer');
        if (!container) {
            console.error('chatContainer not found');
            return;
        }
        
        container.classList.add('active');
        container.style.display = 'flex';
        container.style.visibility = 'visible';
        container.style.opacity = '1';
        container.style.zIndex = '10001';
        
        // ВКЛЮЧАЕМ ПОЛЕ ВВОДА
        const input = document.getElementById('chatInput');
        if (input) {
            input.disabled = false;
            input.readOnly = false;
            input.removeAttribute('disabled');
            input.removeAttribute('readonly');
            input.style.cssText = `
                pointer-events: auto !important;
                opacity: 1 !important;
                display: block !important;
                background: #0a0a0a !important;
                color: #cccccc !important;
                border: 2px solid #3a3a3a !important;
                padding: 13px 17px !important;
                flex: 1 !important;
            `;
            
            setTimeout(() => {
                try {
                    input.focus();
                    console.log('Input focused');
                } catch(e) {
                    console.error('Focus error:', e);
                }
            }, 300);
        } else {
            console.error('chatInput not found');
        }
    }
    
    // 3. ЗАКРЫТИЕ ЧАТА
    function closeChat() {
        const container = document.getElementById('chatContainer');
        if (container) {
            container.classList.remove('active');
            container.style.display = 'none';
        }
    }
    
    // 4. ОТПРАВКА СООБЩЕНИЯ
    function sendMessage() {
        const input = document.getElementById('chatInput');
        if (!input) return;
        
        const message = input.value.trim();
        if (!message) return;
        
        console.log('Sending message:', message);
        
        if (window.sendMessage && typeof window.sendMessage === 'function') {
            window.sendMessage();
        } else {
            console.warn('window.sendMessage not available');
        }
    }
    
    // ИНИЦИАЛИЗАЦИЯ
    function init() {
        console.log('Initializing chat fix...');
        
        // Фиксируем позицию
        forceChatPosition();
        
        // Кнопка открытия
        const chatButton = document.getElementById('chatButton');
        if (chatButton) {
            // Удаляем все старые обработчики
            const newBtn = chatButton.cloneNode(true);
            chatButton.parentNode.replaceChild(newBtn, chatButton);
            const btn = document.getElementById('chatButton');
            
            btn.onclick = function(e) {
                e.preventDefault();
                e.stopPropagation();
                console.log('Chat button clicked');
                openChat();
            };
            
            console.log('Chat button handler added');
        } else {
            console.error('chatButton not found');
        }
        
        // Кнопка закрытия
        const closeBtn = document.getElementById('closeChat');
        if (closeBtn) {
            closeBtn.onclick = function(e) {
                e.preventDefault();
                closeChat();
            };
        }
        
        // Кнопка отправки
        const sendBtn = document.getElementById('sendButton');
        const chatInput = document.getElementById('chatInput');
        
        if (sendBtn) {
            sendBtn.onclick = function(e) {
                e.preventDefault();
                sendMessage();
            };
        }
        
        if (chatInput) {
            chatInput.onkeypress = function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    sendMessage();
                }
            };
        }
        
        // Быстрые вопросы
        setTimeout(() => {
            document.querySelectorAll('.quick-question-btn').forEach(btn => {
                btn.onclick = function(e) {
                    e.preventDefault();
                    const question = this.getAttribute('data-question') || this.textContent.trim();
                    if (question && chatInput) {
                        chatInput.value = question;
                        setTimeout(() => sendMessage(), 100);
                    }
                };
            });
        }, 500);
        
        console.log('Chat fix initialized');
    }
    
    // Запускаем
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    // Постоянно фиксируем позицию
    setInterval(forceChatPosition, 500);
    window.addEventListener('scroll', forceChatPosition, { passive: true });
    window.addEventListener('resize', forceChatPosition);
    
    // Глобальные функции
    window.openChat = openChat;
    window.closeChat = closeChat;
    
})();

