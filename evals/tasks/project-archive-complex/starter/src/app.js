const projects = await (await fetch('/api/projects')).json();
for (const project of projects) { const item = document.createElement('li'); item.textContent = project.name; document.querySelector('#projects').append(item); }
// TODO: archive, restore and filter controls.
