const menus = ["File", "Edit", "Windows", "Project", "Animation", "Display", "Tools", "Help"];

export function MenuBar() {
  return (
    <nav className="menu-bar" aria-label="Application menu">
      <div className="menu-brand">GrapiX</div>
      {menus.map((menu) => (
        <button className="menu-item" key={menu}>
          {menu}
        </button>
      ))}
    </nav>
  );
}
