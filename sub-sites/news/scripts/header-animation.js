const lines = document.querySelectorAll('.header .line');

function toggleScatter() {
    lines.forEach(line => {
        if (line.classList.contains('scatter')) {
            line.classList.remove('scatter');
            line.classList.add('gather');
        } else {
            line.classList.remove('gather');
            line.classList.add('scatter');
        }
    });
}

// Start with gather state and toggle every 4 seconds
window.onload = function() {
    lines.forEach(line => {
        line.classList.add('gather');
    });
    setInterval(toggleScatter, 4000);
};

