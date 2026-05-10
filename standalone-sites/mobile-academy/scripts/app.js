const tabs = document.querySelectorAll('[data-tab]');
const panels = document.querySelectorAll('[data-panel]');
const joinDialog = document.querySelector('#joinDialog');
const openJoinButtons = document.querySelectorAll('[data-open-join]');
const closeJoinButtons = document.querySelectorAll('[data-close-join]');

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;

    tabs.forEach((item) => {
      item.classList.toggle('is-active', item === tab);
    });

    panels.forEach((panel) => {
      panel.classList.toggle('is-active', panel.dataset.panel === target);
    });
  });
});

openJoinButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (!joinDialog) return;

    if (typeof joinDialog.showModal === 'function') {
      joinDialog.showModal();
      return;
    }

    joinDialog.setAttribute('open', '');
  });
});

closeJoinButtons.forEach((button) => {
  button.addEventListener('click', () => {
    joinDialog?.close();
  });
});

joinDialog?.addEventListener('click', (event) => {
  if (event.target === joinDialog) {
    joinDialog.close();
  }
});
