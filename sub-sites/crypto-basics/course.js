// Subscription check - use window object to avoid conflicts with chatbot.js
(function() {
    'use strict';
    if (typeof window.COURSE_API_BASE_URL === 'undefined') {
        window.COURSE_API_BASE_URL = window.__API_BASE_URL__ || (window.location.hostname === 'localhost' ? 'http://localhost:4000' : window.location.origin);
    }
})();
const API_BASE_URL = window.COURSE_API_BASE_URL;

function getUserId() {
    const storageKey = 'crypto_academy_user_id';
    let userId = localStorage.getItem(storageKey);
    if (!userId) {
        // Generate UUID manually - always use fallback to avoid crypto.randomUUID errors
        // Fallback: generate a simple unique ID
        userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem(storageKey, userId);
    }
    return userId;
}

let subscriptionStatus = null;

// Make fetchSubscriptionStatus global
window.fetchSubscriptionStatus = async function fetchSubscriptionStatus() {
    try {
        const userId = getUserId();
        const response = await fetch(`${API_BASE_URL}/api/status?userId=${encodeURIComponent(userId)}`);
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        subscriptionStatus = data;
        return data;
    } catch (error) {
        console.error('Error fetching subscription status:', error);
        return null;
    }
};

// Make hasActiveSubscription global
window.hasActiveSubscription = function hasActiveSubscription() {
    if (!subscriptionStatus) return false;
    
    // Check if user has active subscription
    if (subscriptionStatus.hasActiveAccess) {
        return true;
    }
    
    // Check trial period
    if (subscriptionStatus.trialActive) {
        const trialEnd = new Date(subscriptionStatus.trialEndsAt);
        return trialEnd > new Date();
    }
    
    return false;
};

// Course functionality - SIMPLIFIED AND FIXED
window.toggleLesson = function toggleLesson(element, event) {
    try {
        // Prevent event bubbling and default behavior
        if (event) {
            event.stopPropagation();
            event.preventDefault();
        }
        
        // Prevent double calls - check if we're already processing
        if (element.dataset.processing === 'true') {
            console.log('⏸️ Already processing, skipping...');
            return false;
        }
        element.dataset.processing = 'true';
        setTimeout(() => {
            element.dataset.processing = 'false';
        }, 300);
        
        console.log('=== toggleLesson CALLED ===', element);
        
        // Get lesson item
        const lessonItem = element.closest('.lesson-item');
        if (!lessonItem) {
            console.error('❌ Lesson item not found');
            element.dataset.processing = 'false';
            return false;
        }
        
        // Check if lesson is locked
        if (lessonItem.classList.contains('lesson-locked')) {
            console.log('🔒 Lesson is locked, showing modal');
            if (window.showSubscriptionModal) {
                window.showSubscriptionModal();
            }
            element.dataset.processing = 'false';
            return false;
        }
        
        // Check if this is a paid lesson (blocks 2-6)
        const lessonNumber = lessonItem.querySelector('.lesson-number');
        if (lessonNumber) {
            const lessonNum = parseInt(lessonNumber.textContent);
            
            // Block 1 is FREE - always allow to open
            // Blocks 2-6 are PAID
            if (lessonNum >= 2 && lessonNum <= 6) {
                // Check subscription status
                if (!window.hasActiveSubscription || !window.hasActiveSubscription()) {
                    console.log('💳 Paid block without subscription, showing modal');
                    if (window.showSubscriptionModal) {
                        window.showSubscriptionModal();
                    }
                    element.dataset.processing = 'false';
                    return false;
                }
            }
        }
        
        // Get content and arrow
        const content = lessonItem.querySelector('.lesson-content');
        let arrow = element.querySelector('.lesson-arrow');
        if (!arrow) {
            arrow = lessonItem.querySelector('.lesson-arrow');
        }
        
        if (!content || !arrow) {
            console.error('❌ Content or arrow not found');
            element.dataset.processing = 'false';
            return false;
        }
        
        // Close all other lessons
        document.querySelectorAll('.lesson-item').forEach(item => {
            if (item !== lessonItem) {
                const otherContent = item.querySelector('.lesson-content');
                const otherArrow = item.querySelector('.lesson-arrow');
                if (otherContent && otherArrow) {
                    otherContent.classList.remove('lesson-content-open');
                    item.classList.remove('lesson-open');
                    otherContent.style.cssText = 'display: none !important;';
                    otherArrow.textContent = '▼';
                }
            }
        });
        
        // Simple check: if arrow is ▲, block is open; if ▼, it's closed
        const arrowText = arrow.textContent.trim();
        const isCurrentlyOpen = arrowText === '▲';
        
        console.log('📊 Toggle check:', {
            arrowText: arrowText,
            isOpen: isCurrentlyOpen
        });
        
        // Toggle: if currently open, close it; if closed, open it
        const shouldShow = !isCurrentlyOpen;
        
        if (shouldShow) {
            // Show lesson
            console.log('🔓 Opening lesson...');
            
            // Add classes first
            content.classList.add('lesson-content-open');
            lessonItem.classList.add('lesson-open');
            
            // Set display to block
            content.style.cssText = 'display: block !important; visibility: visible !important; opacity: 1 !important;';
            
            // Update arrow
            arrow.textContent = '▲';
            
            // Smooth scroll to opened lesson after a short delay to ensure content is rendered
            setTimeout(() => {
                // Only scroll if lesson is not fully visible
                const rect = lessonItem.getBoundingClientRect();
                const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
                if (!isVisible || rect.top < 100) {
                    lessonItem.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 100);
            
            console.log('✅ Lesson opened');
        } else {
            // Hide lesson
            console.log('🔒 Closing lesson...');
            
            // Remove classes first
            content.classList.remove('lesson-content-open');
            lessonItem.classList.remove('lesson-open');
            
            // Set display to none
            content.style.cssText = 'display: none !important;';
            
            // Update arrow
            arrow.textContent = '▼';
            
            console.log('✅ Lesson closed');
        }
        
        // Reset processing flag
        element.dataset.processing = 'false';
        return true;
    } catch (error) {
        console.error('❌❌❌ ERROR in toggleLesson:', error);
        console.error('Stack:', error.stack);
        // Reset processing flag even on error
        if (element && element.dataset) {
            element.dataset.processing = 'false';
        }
        return false;
    }
};

// Show subscription modal - make it global
window.showSubscriptionModal = function showSubscriptionModal() {
    const modal = document.getElementById('subscriptionModal');
    if (modal) {
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    } else {
        console.error('Subscription modal not found in DOM');
    }
};

// Close subscription modal - make it global
window.closeSubscriptionModal = function closeSubscriptionModal() {
    const modal = document.getElementById('subscriptionModal');
    if (modal) {
        modal.style.display = 'none';
        document.body.style.overflow = 'auto';
    }
};

// Payment functions - make them global
window.payWithCrypto = async function payWithCrypto() {
    try {
        const userId = getUserId();
        const response = await fetch(`${API_BASE_URL}/api/payments/cryptocloud/invoice`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ userId })
        });
        
        const data = await response.json();
        if (data.paymentUrl) {
            window.open(data.paymentUrl, '_blank');
            // Check subscription status periodically and unlock lessons automatically
            const checkInterval = setInterval(async () => {
                await window.fetchSubscriptionStatus();
                if (window.hasActiveSubscription()) {
                    // User has paid - unlock all lessons automatically
                    console.log('💰 Payment detected! Unlocking lessons 2-6...');
                    window.blockPaidLessons(); // This will unlock lessons 2-6
                    clearInterval(checkInterval);
                    console.log('✅✅✅ Subscription active! Lessons 2-6 unlocked automatically. ✅✅✅');
                    
                    // Show a success message
                    const modal = document.getElementById('subscriptionModal');
                    if (modal) {
                        modal.style.display = 'none';
                    }
                    alert('🎉 Payment successful! All premium lessons are now unlocked!');
                }
            }, 2000); // Check every 2 seconds for faster response
            // Stop checking after 5 minutes
            setTimeout(() => clearInterval(checkInterval), 300000);
        } else {
            alert('Payment error. Please try again.');
        }
    } catch (error) {
        console.error('Payment error:', error);
        alert('Payment error. Please try again.');
    }
};

window.payWithCard = async function payWithCard() {
    try {
        const userId = getUserId();
        // Try NOWPayments first
        const response = await fetch(`${API_BASE_URL}/api/payments/nowpayments/invoice`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ userId })
        });
        
        const data = await response.json();
        if (data.paymentUrl) {
            window.open(data.paymentUrl, '_blank');
            // Check subscription status periodically and unlock lessons automatically
            const checkInterval = setInterval(async () => {
                await window.fetchSubscriptionStatus();
                if (window.hasActiveSubscription()) {
                    // User has paid - unlock all lessons automatically
                    console.log('💰 Payment detected! Unlocking lessons 2-6...');
                    window.blockPaidLessons(); // This will unlock lessons 2-6
                    clearInterval(checkInterval);
                    console.log('✅✅✅ Subscription active! Lessons 2-6 unlocked automatically. ✅✅✅');
                    
                    // Show a success message
                    const modal = document.getElementById('subscriptionModal');
                    if (modal) {
                        modal.style.display = 'none';
                    }
                    alert('🎉 Payment successful! All premium lessons are now unlocked!');
                }
            }, 2000); // Check every 2 seconds for faster response
            // Stop checking after 5 minutes
            setTimeout(() => clearInterval(checkInterval), 300000);
        } else {
            alert('Payment error. Please try again.');
        }
    } catch (error) {
        console.error('Payment error:', error);
        alert('Payment error. Please try again.');
    }
};

// Timeline Modal Functions
function showTimelineDetail(e) {
    if (e && e.stopPropagation) {
        e.stopPropagation();
    }
    
    let clickedElement = e.currentTarget;
    if (!clickedElement) {
        clickedElement = e.target.closest('.timeline-event');
    }
    
    if (!clickedElement) {
        console.error('Timeline event element not found');
        return;
    }
    
    const dataContainer = clickedElement.querySelector('.timeline-data');
    if (!dataContainer) {
        console.error('Timeline data container not found');
        return;
    }
    
    const year = dataContainer.querySelector('.data-year').textContent;
    const eventTitle = dataContainer.querySelector('.data-event').textContent;
    const details = dataContainer.querySelector('.data-details').textContent;

    const modal = document.getElementById('timelineModal');
    const modalYear = document.getElementById('modalYear');
    const modalEventTitle = document.getElementById('modalEventTitle');
    const modalDetails = document.getElementById('modalDetails');

    if (modal && modalYear && modalEventTitle && modalDetails) {
        modalYear.textContent = year;
        modalEventTitle.textContent = eventTitle;
        modalDetails.textContent = details;
        modal.style.display = 'block';
        document.body.style.overflow = 'hidden';
    } else {
        console.error('Modal elements not found');
    }
}

function closeModal() {
    const modal = document.getElementById('timelineModal');
    if (modal) {
        modal.style.display = 'none';
        document.body.style.overflow = 'auto';
    }
}

// Close modal when clicking outside
window.addEventListener('click', function(event) {
    const modal = document.getElementById('timelineModal');
    if (event.target === modal) {
        closeModal();
    }
});

// Close modal with Escape key
document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
        closeModal();
    }
});

// Block paid lessons (2-6) - make it global
window.blockPaidLessons = function blockPaidLessons() {
    const lessonItems = document.querySelectorAll('.lesson-item');
    if (lessonItems.length === 0) {
        console.log('No lesson items found yet');
        return;
    }
    
    console.log('Blocking paid lessons, found', lessonItems.length, 'items');
    
    lessonItems.forEach((item, index) => {
        const lessonNumber = item.querySelector('.lesson-number');
        if (lessonNumber) {
            const lessonNum = parseInt(lessonNumber.textContent);
            // Block lessons 2-6
            if (lessonNum >= 2 && lessonNum <= 6) {
                if (!window.hasActiveSubscription()) {
                    item.classList.add('lesson-locked');
                    const header = item.querySelector('.lesson-header');
                    if (header) {
                        header.style.cursor = 'pointer';
                        header.style.opacity = '0.6';
                        header.style.position = 'relative';
                        
                        // Remove existing overlay if any
                        const existingOverlay = item.querySelector('.lesson-lock-overlay');
                        if (existingOverlay) {
                            existingOverlay.remove();
                        }
                        
                        // Add lock overlay - only emoji, no text
                        // Use createElement instead of innerHTML to avoid TrustedHTML errors
                        const overlay = document.createElement('div');
                        overlay.className = 'lesson-lock-overlay';
                        const lockIcon = document.createElement('div');
                        lockIcon.className = 'lock-icon';
                        lockIcon.textContent = '🔒';
                        overlay.appendChild(lockIcon);
                        overlay.onclick = function(e) {
                            e.stopPropagation();
                            e.preventDefault();
                            window.showSubscriptionModal();
                        };
                        // Make header also show modal when clicked (for locked lessons)
                        const originalOnClick = header.getAttribute('onclick');
                        header.setAttribute('data-original-onclick', originalOnClick || 'toggleLesson(this)');
                        header.onclick = function(e) {
                            e.stopPropagation();
                            e.preventDefault();
                            window.showSubscriptionModal();
                        };
                        item.appendChild(overlay);
                    }
                } else {
                    // User has subscription - FULLY UNLOCK and restore functionality
                    console.log('🔓 Unlocking lesson', lessonNum, 'for subscribed user');
                    
                    item.classList.remove('lesson-locked');
                    
                    // Remove overlay completely
                    const overlay = item.querySelector('.lesson-lock-overlay');
                    if (overlay) {
                        overlay.remove();
                    }
                    
                    const header = item.querySelector('.lesson-header');
                    if (header) {
                        // Restore all styles to normal
                        header.style.opacity = '1';
                        header.style.cursor = 'pointer';
                        header.style.position = '';
                        
                        // Remove all event listeners by cloning the header
                        const newHeader = header.cloneNode(true);
                        header.parentNode.replaceChild(newHeader, header);
                        const restoredHeader = item.querySelector('.lesson-header');
                        
                        if (restoredHeader) {
                            // Set onclick attribute
                            // Remove all existing event listeners by cloning
                            const newHeader = restoredHeader.cloneNode(true);
                            restoredHeader.parentNode.replaceChild(newHeader, restoredHeader);
                            
                            // Set onclick only (no duplicate listeners)
                            const finalHeader = item.querySelector('.lesson-header');
                            if (finalHeader) {
                                finalHeader.setAttribute('onclick', 'window.toggleLesson(this, event)');
                            }
                            
                            console.log('✅ Lesson', lessonNum, 'header fully restored');
                        }
                    }
                    
                    // Ensure content is accessible and can be opened easily
                    const content = item.querySelector('.lesson-content');
                    if (content) {
                        // Remove any blocking styles but keep it closed initially (like block 1)
                        content.style.removeProperty('display');
                        // Ensure it starts closed (like block 1)
                        content.style.display = 'none';
                        
                        // Make sure arrow is set correctly
                        const arrow = item.querySelector('.lesson-arrow');
                        if (arrow) {
                            arrow.textContent = '▼';
                        }
                        
                        console.log('✅ Lesson', lessonNum, 'content prepared for opening');
                    }
                    
                    console.log('✅✅✅ Lesson', lessonNum, 'FULLY UNLOCKED - works like block 1 now! ✅✅✅');
                }
            } else if (lessonNum === 1) {
                // Block 1 is always free - make sure it's not locked
                item.classList.remove('lesson-locked');
                const overlay = item.querySelector('.lesson-lock-overlay');
                if (overlay) {
                    overlay.remove();
                }
                const header = item.querySelector('.lesson-header');
                if (header) {
                    header.style.opacity = '1';
                    // Ensure onclick is set correctly
                    header.setAttribute('onclick', 'window.toggleLesson(this, event)');
                }
                
                // Ensure block 1 starts closed (like all other blocks)
                const content = item.querySelector('.lesson-content');
                const arrow = item.querySelector('.lesson-arrow');
                if (content && arrow) {
                    content.style.display = 'none';
                    arrow.textContent = '▼';
                    content.classList.remove('lesson-content-open');
                    item.classList.remove('lesson-open');
                }
            }
        }
    });
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', async function() {
    console.log('Crypto lessons page loaded successfully');
    
    // Fetch subscription status first
    await window.fetchSubscriptionStatus();
    
    const lessonItems = document.querySelectorAll('.lesson-item');
    console.log('Found', lessonItems.length, 'lesson items on initial load');
    
    // Ensure all lesson content is hidden initially
    lessonItems.forEach(item => {
        const content = item.querySelector('.lesson-content');
        const arrow = item.querySelector('.lesson-arrow');
        if (content && arrow) {
            content.style.display = 'none';
            arrow.textContent = '▼';
        }
    });
    
    // Block paid lessons
    window.blockPaidLessons();
    
    // Refresh subscription status periodically
    setInterval(async () => {
        await window.fetchSubscriptionStatus();
        window.blockPaidLessons();
    }, 30000); // Check every 30 seconds
});
