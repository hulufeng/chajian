// ============ BubaiCode 官方网站交互脚本 ============

// 语言切换
let currentLang = 'zh';
function toggleLang() {
  currentLang = currentLang === 'zh' ? 'en' : 'zh';
  const btn = document.querySelector('.btn-lang');
  if (btn) btn.textContent = currentLang === 'zh' ? 'EN' : '中';
  // 实际项目中这里会切换页面语言
  console.log('语言切换为:', currentLang);
}

// 下载信息展示
function showDownloadInfo() {
  const info = document.getElementById('downloadInfo');
  if (info) {
    info.style.display = info.style.display === 'none' ? 'block' : 'none';
  }
}

// 平滑滚动
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function (e) {
    const href = this.getAttribute('href');
    if (href === '#') return;
    const target = document.querySelector(href);
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// 导航栏滚动效果
let lastScroll = 0;
window.addEventListener('scroll', () => {
  const navbar = document.querySelector('.navbar');
  const currentScroll = window.pageYOffset;

  if (currentScroll > 50) {
    navbar.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';
  } else {
    navbar.style.boxShadow = 'none';
  }

  lastScroll = currentScroll;
});

// 滚动动画（元素进入视口时淡入）
const observerOptions = {
  threshold: 0.1,
  rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
      observer.unobserve(entry.target);
    }
  });
}, observerOptions);

// 为卡片添加动画
document.addEventListener('DOMContentLoaded', () => {
  const animatedElements = document.querySelectorAll('.feature-card, .capability-card, .model-card, .workflow-step');
  animatedElements.forEach((el, index) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = `opacity 0.6s ease ${index * 0.1}s, transform 0.6s ease ${index * 0.1}s`;
    observer.observe(el);
  });

  // 应用窗口 3D 倾斜效果
  const appWindow = document.querySelector('.app-window');
  if (appWindow) {
    const screenshot = document.querySelector('.hero-screenshot');
    screenshot.addEventListener('mousemove', (e) => {
      const rect = screenshot.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      appWindow.style.transform = `rotateY(${x * 4}deg) rotateX(${-y * 4}deg)`;
    });
    screenshot.addEventListener('mouseleave', () => {
      appWindow.style.transform = 'rotateY(-2deg) rotateX(2deg)';
    });
  }

  console.log('✅ BubaiCode 官网加载完成');
});

// 计数器动画（用于统计数字）
function animateCounter(element, target, duration = 2000) {
  const start = 0;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const easeOut = 1 - Math.pow(1 - progress, 3);
    const current = Math.floor(start + (target - start) * easeOut);
    element.textContent = current.toLocaleString();

    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }

  requestAnimationFrame(update);
}
