const isRetardRoute = window.location.pathname === '/retard'
  || window.location.pathname === '/retard/'
  || window.location.pathname === '/retard/index.html';

if (isRetardRoute) {
  import('./retard.css');
  import('./retard-app.js');
} else {
  import('./legacy.css');
  import('./dashboard-app.js');
}
