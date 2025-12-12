// Course functionality
function toggleLesson(element) {
    try {
        const lessonItem = element.closest('.lesson-item');
        if (!lessonItem) {
            console.error('Lesson item not found');
            return;
        }
        
        const content = lessonItem.querySelector('.lesson-content');
        const arrow = element.querySelector('.lesson-arrow');
        
        if (!content || !arrow) {
            console.error('Content or arrow not found');
            return;
        }
        
        // Close all other lessons
        document.querySelectorAll('.lesson-item').forEach(item => {
            if (item !== lessonItem) {
                const otherContent = item.querySelector('.lesson-content');
                const otherArrow = item.querySelector('.lesson-arrow');
                if (otherContent && otherArrow) {
                    otherContent.style.display = 'none';
                    otherArrow.textContent = '▼';
                }
            }
        });
        
        // Toggle current lesson
        if (content.style.display === 'none' || content.style.display === '') {
            content.style.display = 'block';
            arrow.textContent = '▲';
        } else {
            content.style.display = 'none';
            arrow.textContent = '▼';
        }
    } catch (error) {
        console.error('Error in toggleLesson:', error);
    }
}

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

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', function() {
    console.log('Crypto lessons page loaded successfully');
    
    const lessonItems = document.querySelectorAll('.lesson-item');
    console.log('Found', lessonItems.length, 'lesson items');
    
    // Ensure all lesson content is hidden initially
    lessonItems.forEach(item => {
        const content = item.querySelector('.lesson-content');
        const arrow = item.querySelector('.lesson-arrow');
        if (content && arrow) {
            content.style.display = 'none';
            arrow.textContent = '▼';
        }
    });
});

