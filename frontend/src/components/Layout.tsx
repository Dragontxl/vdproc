import { useState } from 'react';
import { Layout as AntLayout, Menu, Button } from 'antd';
import {
  DashboardOutlined,
  VideoCameraOutlined,
  UserOutlined,
  SettingOutlined,
  BarChartOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';

const { Header, Sider, Content } = AntLayout;

type MenuItem = Required<MenuProps>['items'][number];

const menuItems: MenuItem[] = [
  {
    key: '/',
    icon: <DashboardOutlined />,
    label: '仪表盘',
  },
  {
    key: '/tasks',
    icon: <VideoCameraOutlined />,
    label: '任务管理',
  },
  {
    key: '/accounts',
    icon: <UserOutlined />,
    label: '账户管理',
  },
  {
    key: '/metrics',
    icon: <BarChartOutlined />,
    label: '监控指标',
  },
  {
    key: '/config',
    icon: <SettingOutlined />,
    label: '系统配置',
  },
];

interface LayoutProps {
  children?: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const handleMenuClick: MenuProps['onClick'] = (e) => {
    navigate(e.key);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    navigate('/login');
  };

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <Sider
        theme="dark"
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        style={{
          overflow: 'auto',
          height: '100vh',
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
        }}
      >
        <div className="logo" style={{ padding: '16px', textAlign: 'center' }}>
          <h2 style={{ color: '#fff', margin: 0, fontSize: collapsed ? '16px' : '18px' }}>
            {collapsed ? 'AI' : 'AI Video'}
          </h2>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={handleMenuClick}
        />
      </Sider>
      <AntLayout style={{ marginLeft: collapsed ? 80 : 200, transition: 'margin 0.2s' }}>
        <Header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 24px' }}>
          <h1 style={{ color: '#fff', margin: 0, fontSize: '18px' }}>AI视频生成系统</h1>
          <Button icon={<LogoutOutlined />} onClick={handleLogout}>
            退出登录
          </Button>
        </Header>
        <Content style={{ padding: '24px', margin: '24px', background: '#141414', borderRadius: '8px' }}>
          {children}
        </Content>
      </AntLayout>
    </AntLayout>
  );
}