import { test } from '@japa/runner'
import { BloomFilterManager } from '../dist/Bloom-filter-manager.js'
import { Revoker } from '../dist/index.js'
import sinon from 'sinon'

test.group('BloomFilterManager Constructor Validation', () => {
  test('constructor throws error when numItems is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      fpRate: 0.01,
      rotateTime: 1000,
    })).toThrow('numItems must be a positive integer.')
  })

  test('constructor throws error when numItems is not an integer', ({ expect }) => {
    expect(() => new BloomFilterManager({
      numItems: 1000.5,
      fpRate: 0.01,
      rotateTime: 1000,
    })).toThrow('numItems must be a positive integer.')
  })

  test('constructor throws error for invalid numItems', ({expect}) => {
    expect(() => new BloomFilterManager({
      numItems: -1,
      fpRate: 0.01,
      rotateTime: 1000,
    })).toThrow('numItems must be a positive integer.')
  })

  test('constructor throws error when fpRate is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      rotateTime: 1000,
    })).toThrow('fpRate must be a number between 0 and 1 (exclusive).')
  })
  test('constructor throws error for invalid fpRate', ({expect}) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 1.5,
      rotateTime: 1000,
    })).toThrow('fpRate must be a number between 0 and 1 (exclusive).')
  })

  test('constructor throws error when rotateTime is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
    })).toThrow('rotateTime must be a positive integer.')
  })

  test('constructor throws error when rotateTime is not an integer', ({ expect }) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000.5,
    })).toThrow('rotateTime must be a positive integer.')
  })

  test('constructor throws error for invalid rotateTime', ({expect}) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 0,
    })).toThrow('rotateTime must be a positive integer.')
  })
})

test.group('BloomFilterManager Error Handling', (group) => {
  let manager
  let createBloomFilterStub
  let consoleErrorSpy
  let addStub
  let testStubCurrent

  group.setup(() => {
    manager = new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
    })
    createBloomFilterStub = sinon.stub(manager, '_createBloomFilter').throws(new Error('Test Error'))
    consoleErrorSpy = sinon.spy(console, 'error')
    addStub = sinon.stub(manager.current, 'add').throws(new Error('Add Error'))
  })

  group.teardown(() => {
    createBloomFilterStub.restore()
    consoleErrorSpy.restore()
    addStub.restore()
    manager.destroy()
  })

  test('rotate method logs error when _createBloomFilter throws', async ({ expect }) => {
    await manager.rotate()
    expect(consoleErrorSpy.calledOnce).toBe(true)
    expect(consoleErrorSpy.firstCall.args[0]).toBe('Error rotating Bloom filters:')
    expect(consoleErrorSpy.firstCall.args[1].message).toBe('Test Error')
  })

  test('add method logs error when current.add throws', ({ expect }) => {
    consoleErrorSpy.resetHistory()
    const value = 'testValue'
    expect(() => manager.add(value)).toThrow('Add Error')
    expect(consoleErrorSpy.calledOnce).toBe(true)
    expect(consoleErrorSpy.firstCall.args[0]).toBe('Error adding value to Bloom filter:')
    expect(consoleErrorSpy.firstCall.args[1].message).toBe('Add Error')
  })

  test('reset method logs error when _createBloomFilter throws', async ({ expect }) => {
    consoleErrorSpy.resetHistory()
    createBloomFilterStub.throws(new Error('Reset Error'))
    await expect(manager.reset()).rejects.toThrow('Reset Error')
    expect(consoleErrorSpy.calledOnce).toBe(true)
    expect(consoleErrorSpy.firstCall.args[0]).toBe('Error resetting Bloom filters:')
    expect(consoleErrorSpy.firstCall.args[1].message).toBe('Reset Error')
  })

  test('has method logs error when current.test throws', ({ expect }) => {
    consoleErrorSpy.resetHistory()
    const value = 'testValue'
    testStubCurrent = sinon.stub(manager.current, 'test').throws(new Error('Test Error'))
    const result = manager.has(value)
    
    expect(result).toBe(false)
    expect(consoleErrorSpy.calledOnce).toBe(true)
    expect(consoleErrorSpy.firstCall.args[0]).toBe('Error in has:')
    expect(consoleErrorSpy.firstCall.args[1].message).toBe('Test Error')
  })
})

test.group('BloomFilterManager Functional Tests', (group) => {
  let manager
  let clearIntervalSpy

  group.setup(() => {
    clearIntervalSpy = sinon.spy(global, 'clearInterval')
    manager = new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000, // 1 second for testing
    })
  })

  group.teardown(() => {
    manager.destroy()
    clearIntervalSpy.restore()
  })

  test('filters rotate correctly after rotateTime', async ({expect}) => {
    manager.add('value1')
    expect(manager.has('value1')).toBe(true)
    // Wait for rotation to occur
    await new Promise((resolve) => setTimeout(resolve, 1100)) // wait slightly more than rotateTime
    manager.add('value2')
    expect(manager.has('value1')).toBe(true)
    expect(manager.has('value2')).toBe(true)
  })

  test('add method adds a string value', ({expect}) => {
    manager.add('testValue')
    expect(manager.has('testValue')).toBe(true)
  })

  test('add method throws error when adding non-string', ({expect}) => {
    expect(() => manager.add(123)).toThrow('Value must be a string.')
  })

  test('has method returns true for added values', ({expect}) => {
    const value = 'testValue'
    manager.add(value)
    expect(manager.has(value)).toBe(true)
  })

  test('has method returns false for non-added values', ({expect}) => {
    expect(manager.has('nonExistent')).toBe(false)
  })

  test('reset method clears the Bloom filters', async ({expect}) => {
    manager.add('testValue')
    await manager.reset()
    expect(manager.has('testValue')).toBe(false)
  })

  test('destroy method properly cleans up the manager', ({ expect }) => {
    manager.destroy()
    expect(manager.previous).toBeNull()
    expect(manager.current).toBeNull()
    expect(manager.rotationInterval).toBeNull()
    expect(clearIntervalSpy.calledOnce).toBe(true)
  })

  test('stopRotation method stops the rotation process', ({ expect }) => {
    manager.stopRotation()
    expect(manager.rotationInterval).toBeNull()
    expect(clearIntervalSpy.calledOnce).toBe(true)
  })

  test('tokens are correctly rotated and expired after rotateTime', async ({ expect }) => {
    const manager = new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 10,
    })
    const tokens = ['alpha', 'beta', 'gamma']
    tokens.forEach((token) => manager.add(token))
    tokens.forEach((token) => {
      expect(manager.has(token)).toBe(true) // check current bloom filter
    })
    await new Promise((resolve) => setTimeout(resolve, 12))
  
    tokens.forEach((token) => {
      expect(manager.has(token)).toBe(true) // check previous bloom filter
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    tokens.forEach((token) => {
      expect(manager.has(token)).toBe(false)
    })

    manager.destroy()
  })
})

test.group('Revoker Class Tests', (group) => {
  let destroySpy

  group.teardown(() => {
    
  })

  test('constructor initializes BloomFilterManager with correct options', ({ expect }) => {
    const config = {
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2']
    }
    const instance = new Revoker(config)
    expect(instance.bloomFilterManager).toBeInstanceOf(BloomFilterManager)
    expect(instance.bloomFilterManager.numItems).toBe(config.numItems)
    expect(instance.bloomFilterManager.fpRate).toBe(config.fpRate)
    expect(instance.bloomFilterManager.rotateTime).toBe(config.rotateTime)
    expect(instance.bloomFilterManager.current).toBeDefined()
    expect(instance.bloomFilterManager.previous).toBeNull()
    expect(instance.bloomFilterManager.rotationInterval).toBeDefined()
    instance.bloomFilterManager.destroy()
  })

  test('constructor initializes middleware with claimsToCheck', ({ expect }) => {
    const config = {
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2']
    }
    const instance = new Revoker(config)
    const middleware = instance.getMiddleware()
    expect(middleware).toBeDefined()
    expect(middleware).toBeInstanceOf(Function)
    expect(middleware.length).toBe(3)
    instance.bloomFilterManager.destroy()
  })

  test('constructor initializes middleware with opaqueHeader', ({ expect }) => {
    const config = {
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization'
    }
    const instance = new Revoker(config)
    const middleware = instance.getMiddleware()
    expect(middleware).toBeDefined()
    expect(middleware).toBeInstanceOf(Function)
    expect(middleware.length).toBe(3)
    instance.bloomFilterManager.destroy()
  })

  test('add(filterItem) calls bloomFilterManager.add when bloomFilterManager is set', ({ expect }) => {
    const addStub = sinon.stub(BloomFilterManager.prototype, 'add');

    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2']
    });
    
    const filterItem = 'testItem';
    revoker.add(filterItem);
    expect(addStub.calledWith(filterItem)).toBe(true);
    addStub.restore();
    revoker.destroy();
  });
})

test.group('Revoker Error Handling', (group) => {
  let destroySpy

  group.setup(() => {
    destroySpy = sinon.spy(BloomFilterManager.prototype, 'destroy')
  })

  group.teardown(() => {
    destroySpy.restore()
  })

  test('constructor throws error when neither claimsToCheck nor opaqueHeader is provided', ({ expect }) => {
    expect(() => new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000
    })).toThrow('claimsToCheck or opaqueHeader must be provided')
    expect(destroySpy.called).toBe(true)
  })

  test('constructor throws error when BloomFilterManager throws error', ({ expect }) => {
    const config = {
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2']
    }
    const createBloomFilterStub = sinon.stub(BloomFilterManager.prototype, '_createBloomFilter').throws(new Error('Test Error'))
    expect(() => new Revoker(config)).toThrow('Test Error')
    expect(destroySpy.called).toBe(true)
    createBloomFilterStub.restore()
  })

  test('getMiddleware throws error when middleware is not configured', ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2']
      // 'middleware' is intentionally not provided
    });
    revoker.middleware = null
    expect(() => revoker.getMiddleware()).toThrow('Middleware not configured');
    revoker.destroy()
  })
})

test.group('Revoker Functional Tests', (group) => {

test('createJWTMiddleware correctly checks claimsToCheck', async ({ expect }) => {
  const revoker = new Revoker({
    numItems: 1000,
    fpRate: 0.01,
    rotateTime: 1000,
    claimsToCheck: ['claim1', 'claim2']
  });
  
  const middleware = revoker.getMiddleware();
  const next = sinon.spy();
  const req = {
    token: {
      claim1: 'value1',
      claim2: 'value2'
    }
  }

  const res = {
    status: sinon.stub().returnsThis(),
    json: sinon.stub(),
    send: sinon.stub()
  };
  
  middleware(req, res, next);
  
  expect(next.calledOnce).toBe(true);
  expect(next.firstCall.args[0]).toBeUndefined();
  
  expect(res.status.notCalled).toBe(true);
  expect(res.json.notCalled).toBe(true);
  expect(res.send.notCalled).toBe(true);
  revoker.destroy();
  });

  test('createJWTMiddleware throws error when token is missing', ({expect}) => {
    const req = {};
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };
    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2']
    });
    const createJWTMiddleware = revoker.getMiddleware();
  
    expect(() => {
      createJWTMiddleware(req, res, next);
    }).toThrow(new Error("Missing jwt token"));
    revoker.destroy();
  });

  test('createJWTMiddleware with missing claimsToCheck', ({expect}) => {
    const req = {
      token: {
        claim1: 'value1',
      }
    };
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };
    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2']
    });
    const createJWTMiddleware = revoker.getMiddleware();

    expect(() => {
      createJWTMiddleware(req, res, next);
    }).toThrow(new Error("Missing claim2 claim in JWT token"));
    revoker.destroy();
  });

  test('createJWTMiddleware with blacklisted token', ({expect}) => {
    const req = {
      token: {
        claim1: 'value1',
        claim2: 'value2'
      }
    };
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };

    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2']
    });
    revoker.add('claim1-value1');
    const createJWTMiddleware = revoker.getMiddleware();

    expect(() => {
      createJWTMiddleware(req, res, next);
    }).toThrow(new Error("Token claim1 is blacklisted"));
    revoker.destroy();
  });

  test('createOpaqueMiddleware throws error when header is missing', ({expect}) => {
    const req = {
      headers: {}
    };
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };
    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization'
    });
    const createOpaqueMiddleware = revoker.getMiddleware();

    expect(() => {
      createOpaqueMiddleware(req, res, next);
    }).toThrow(new Error("Missing header: Authorization"));
    revoker.destroy();
  });

  test('createOpaqueMiddleware throws error when authorization header is missing and needed', ({expect}) => {
    const req = {
      headers: {
        Authorization: ''
      }
    };
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };
    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization'
    });
    const createOpaqueMiddleware = revoker.getMiddleware();

    expect(() => {
      createOpaqueMiddleware(req, res, next);
    }).toThrow(new Error("Missing header: Authorization"));
    revoker.destroy();
  });

  test('createOpaqueMiddleware throws error when custom header is missing and needed', ({expect}) => {
    const req = {
      headers: {
        CustomHeader: ''
      }
    };
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };
    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'X-Auth-Token'
    });
    const createOpaqueMiddleware = revoker.getMiddleware();

    expect(() => {
      createOpaqueMiddleware(req, res, next);
    }).toThrow(new Error("Missing header: X-Auth-Token"));
    revoker.destroy();
  });

  test('createOpaqueMiddleware throws error when authorization header is invalid', ({expect}) => {
    const req = {
      headers: {
        "authorization": 'randomeValue', // invalid format,Bearer token expected
      }
    };
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };

    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization'
    });
    const createOpaqueMiddleware = revoker.getMiddleware();

    expect(() => {
      createOpaqueMiddleware(req, res, next);
    }).toThrow(new Error('Invalid authorization header'));
    revoker.destroy();
  });

  test('createOpaqueMiddleware throws error when token in Authorization is blacklisted', ({expect}) => {
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };

    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization'
    });
    const createOpaqueMiddleware = revoker.getMiddleware();
    const token = 'testToken'
    const req = {
      headers: {
        authorization: 'Bearer ' + token
      }
    };
    revoker.add(token);

    expect(() => {
      createOpaqueMiddleware(req, res, next);
    }
    ).toThrow(new Error('Token is blacklisted'));
    revoker.destroy();
  });

  test('createOpaqueMiddleware throws error when token in custom header is blacklisted', ({expect}) => {
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };

    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'X-Auth-Token'
    });
    const createOpaqueMiddleware = revoker.getMiddleware();
    const token = 'testToken'
    const req = {
      headers: {
        'x-auth-token': token
      }
    };
    revoker.add(token);

    expect(() => {
      createOpaqueMiddleware(req, res, next);
    }
    ).toThrow(new Error('Token is blacklisted'));
    revoker.destroy();
  });

  test('createOpaqueMiddleware correctly checks headers receveid an needed', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization'
    });

    const middleware = revoker.getMiddleware();
    const next = sinon.spy();
    const req = {
      headers: {
        authorization: 'Bearer testToken'
      }
    }

    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };

    middleware(req, res, next);
    expect(next.calledOnce).toBe(true);
    expect(next.firstCall.args[0]).toBeUndefined();
    revoker.destroy();
  
  });
    
})


// test.group('BloomFilterManager Functional Tests 2', (group) => {
//   let manager
//   let addStubCurrent
//   let addStubPrevious

//   group.setup(() => {
//     manager = new BloomFilterManager({
//       numItems: 1000,
//       fpRate: 0.01,
//       rotateTime: 1000,
//     })
//     addStubCurrent = sinon.stub(manager.current, 'add')
//     manager.previous = manager._createBloomFilter() // simulate one rotation otherwise previous is null
//     addStubPrevious = sinon.stub(manager.previous, 'add')
//   })

//   group.teardown(() => {
//     addStubCurrent.restore()
//     addStubPrevious.restore()
//     manager.destroy()
//   })

//   test('has method correctly checks current and previous Bloom filters', ({ expect }) => {
//     const valueInCurrent = 'currentValue'
//     const valueInPrevious = 'previousValue'
//     const valueNotInFilters = 'notInFilter'

//     // Stub the test method for current and previous
//     const testStubCurrent = sinon.stub(manager.current, 'test')
//       .withArgs(valueInCurrent).returns(true)
//       .withArgs(valueNotInFilters).returns(false)
//     const testStubPrevious = sinon.stub(manager.previous, 'test')
//       .withArgs(valueInPrevious).returns(true)
//       .withArgs(valueNotInFilters).returns(false)

//     // Test values
//     expect(manager.has(valueInCurrent)).toBe(true)
//     expect(manager.has(valueInPrevious)).toBe(true)
//     expect(manager.has(valueNotInFilters)).toBe(false)
//   })
// })
