const nav = document.getElementById('nav');

if (nav) {
  // 只有一件事：滚起来之后玻璃变厚。颜色判定已经删掉了——
  // 导航现在是固定材质的白玻璃 + 深字，压到哪都成立，不需要知道底下是什么。
  const onScroll = () => nav.classList.toggle('stuck', window.scrollY > 10);
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });
}

const items = Array.from(document.querySelectorAll<HTMLElement>('[data-rv]'));

if (!('IntersectionObserver' in window)) {
  items.forEach((el) => el.classList.add('in'));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
  );
  items.forEach((el) => io.observe(el));

  // 兜底：观察器没触发（脚本晚到 / 用户已滚过）时，1.2 秒后把视口内的直接显示
  setTimeout(() => {
    items.forEach((el) => {
      if (el.getBoundingClientRect().top < innerHeight) el.classList.add('in');
    });
  }, 1200);
}
