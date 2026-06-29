import { useState, useEffect } from 'react';
import { Card, Row, Col, Statistic, Table } from 'antd';
import {
  ClockCircleOutlined,
  CheckCircleOutlined,
  AlertOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { configApi } from '../api';
import dayjs from 'dayjs';

export default function Metrics() {
  const [metrics, setMetrics] = useState([]);
  const [stats, setStats] = useState({
    pending: 0,
    processing: 0,
    completed: 0,
  });

  useEffect(() => {
    loadMetrics();
  }, []);

  const loadMetrics = async () => {
    try {
      const result = await configApi.getAll();
      setMetrics(result.data);

      const pendingMetric = result.data.find((m: any) => m.key === 'pending_tasks');
      const processingMetric = result.data.find((m: any) => m.key === 'processing_tasks');
      const completedMetric = result.data.find((m: any) => m.key === 'daily_completed_tasks');

      setStats({
        pending: pendingMetric ? parseInt(pendingMetric.value) : 0,
        processing: processingMetric ? parseInt(processingMetric.value) : 0,
        completed: completedMetric ? parseInt(completedMetric.value) : 0,
      });
    } catch (error) {
      console.error('Failed to load metrics:', error);
    }
  };

  const recentMetrics = [
    { name: 'pending_tasks', label: '等待中任务', value: stats.pending, icon: <ClockCircleOutlined /> },
    { name: 'processing_tasks', label: '处理中任务', value: stats.processing, icon: <SyncOutlined /> },
    { name: 'daily_completed_tasks', label: '今日完成', value: stats.completed, icon: <CheckCircleOutlined /> },
  ];

  const columns = [
    {
      title: '指标名称',
      dataIndex: 'key',
      key: 'key',
    },
    {
      title: '当前值',
      dataIndex: 'value',
      key: 'value',
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      render: (time: string) => dayjs(time).format('MM-DD HH:mm'),
    },
  ];

  return (
    <div>
      <h2>监控指标</h2>
      <Row gutter={16} style={{ marginBottom: 24 }}>
        {recentMetrics.map((metric) => (
          <Col span={8} key={metric.name}>
            <Card>
              <Statistic
                title={metric.label}
                value={metric.value}
                prefix={metric.icon}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <Card title="系统指标" style={{ marginBottom: 24 }}>
        <Table
          dataSource={metrics}
          columns={columns}
          rowKey="key"
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <Card title="告警历史">
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <AlertOutlined style={{ fontSize: '48px', color: '#999' }} />
          <p style={{ marginTop: '16px', color: '#999' }}>暂无告警记录</p>
        </div>
      </Card>
    </div>
  );
}