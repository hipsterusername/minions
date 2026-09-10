const filter = document.querySelector('#filter');
const list = document.querySelector('#projects');
async function refresh() {
  const response = await fetch('/api/projects?archived=' + filter.value);
  if (!response.ok) throw new Error('Unable to load projects');
  const projects = await response.json();
  list.replaceChildren();
  for (const project of projects) {
    const item = document.createElement('li'); item.dataset.projectId = project.id;
    const name = document.createElement('span'); name.textContent = project.name; item.append(name);
    const action = document.createElement('button'); action.textContent = project.archivedAt === null ? 'Archive' : 'Restore';
    action.addEventListener('click', async () => {
      try {
        const result = await fetch('/api/projects/' + encodeURIComponent(project.id) + '/' + (project.archivedAt === null ? 'archive' : 'restore'), {method:'POST'});
        if (!result.ok) throw new Error('Unable to update project');
        await refresh();
      } catch (error) { document.querySelector('#error').textContent = error.message; }
    });
    item.append(action); list.append(item);
  }
}
filter.addEventListener('change', () => refresh().catch(error => { document.querySelector('#error').textContent = error.message; }));
refresh().catch(error => { document.querySelector('#error').textContent = error.message; });
